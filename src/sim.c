/*
  sim.c - single threaded hardware simulation and host (JS) glue for the wasm target

  Part of grblHALweb

  grblHAL is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  grblHAL is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with grblHAL. If not, see <http://www.gnu.org/licenses/>.
*/

#include <math.h>
#include <string.h>

#include <emscripten.h>

#include "sim.h"
#include "mcu.h"
#include "driver.h"

#include "grbl/hal.h"
#include "grbl/crc.h"
#include "grbl/planner.h"
#include "grbl/state_machine.h"

#define TICKS_PER_MS (F_CPU / 1000)
#define YIELD_AHEAD_MS 4.0      // sleep only once simulated time is this far ahead of wall time
#define YIELD_INTERVAL_MS 16.0  // yield at least this often (wall time) so the host stays responsive
#define MAX_LAG_MS 100.0        // re-anchor instead of racing to catch up after falling behind

#define INBUF_SIZE 1024
#define OUTBUF_SIZE 4096
// Sample record, one per SAMPLE_STRIDE doubles:
// t (s), grbl state, spindle rpm (negative = ccw), coolant mask, homed axes mask,
// physical axis positions (mm), grbl MPos (mm)
#define SAMPLE_AXES 5
#define SAMPLE_STRIDE (SAMPLE_AXES + 2 * N_AXIS)
#define SAMPLE_BUF_N 1024

sim_t sim;

static struct {
    uint8_t data[INBUF_SIZE];
    uint16_t head, tail;
} inbuf;

static struct {
    uint8_t data[OUTBUF_SIZE];
    uint16_t len;
} outbuf;

static struct {
    double data[SAMPLE_BUF_N * SAMPLE_STRIDE];
    uint16_t n;
    uint64_t period;            // ticks between samples while moving
    uint64_t next;
    int32_t last_position[N_AXIS];
    sys_state_t last_state;
    bool moving;
    bool dirty;                 // actuator state changed - sample immediately
} samples;

static struct {
    int32_t steps[N_AXIS];      // physical motor position, 0 = minimum end of travel
    bool stepped;
    uint16_t limits;
} machine;

static struct {
    bool on, ccw;
    float rpm;
    uint8_t coolant;
} actuators;

static struct {
    double speed;               // requested simulated seconds per wall second, 0 = as fast as possible
    double effective;           // speed currently being paced against
    double anchor_wall_ms;
    double anchor_sim_ms;
    double last_yield_ms;
    uint64_t next_check;
} pace;

static uint8_t nvs[SIM_NVS_SIZE];
static bool nvs_dirty;

/*
 * Host interface. The host (see web/grblhal.js) installs Module.host before
 * the runtime starts; every call here is synchronous, wasm is never re-entered.
 */

EM_JS(int, host_serial_read, (uint8_t *buf, int max), {
    return Module.host.serialRead(HEAPU8.subarray(buf, buf + max));
});

EM_JS(void, host_serial_write, (const uint8_t *buf, int len), {
    Module.host.serialWrite(HEAPU8.slice(buf, buf + len));
});

EM_JS(void, host_samples, (const double *buf, int count, int stride), {
    Module.host.samples(HEAPF64.slice(buf >> 3, (buf >> 3) + count * stride), count, stride);
});

EM_JS(int, host_nvs_load, (uint8_t *buf, int size), {
    return Module.host.nvsLoad(HEAPU8.subarray(buf, buf + size)) ? 1 : 0;
});

EM_JS(void, host_nvs_save, (const uint8_t *buf, int size), {
    Module.host.nvsSave(HEAPU8.slice(buf, buf + size));
});

EM_JS(void, host_clock, (double seconds), {
    Module.host.clock(seconds);
});

EM_JS(double, host_speed, (void), {
    return Module.host.speed();
});

static inline double sim_ms (void)
{
    return (double)sim.masterclock / (double)TICKS_PER_MS;
}

static void flush_output (void)
{
    if(outbuf.len) {
        host_serial_write(outbuf.data, outbuf.len);
        outbuf.len = 0;
    }
}

static void flush_samples (void)
{
    if(samples.n) {
        host_samples(samples.data, samples.n, SAMPLE_STRIDE);
        samples.n = 0;
    }
}

static void pull_input (void)
{
    uint8_t chunk[INBUF_SIZE];
    uint16_t free = (inbuf.tail - inbuf.head - 1) & (INBUF_SIZE - 1);
    int n = free ? host_serial_read(chunk, free) : 0;

    for(int i = 0; i < n; i++) {
        inbuf.data[inbuf.head] = chunk[i];
        inbuf.head = (inbuf.head + 1) & (INBUF_SIZE - 1);
    }

    sim.input_pending = inbuf.head != inbuf.tail;
}


// The only place control is handed back to the host event loop.
static void sim_yield (double ms)
{
    flush_output();
    flush_samples();
    host_clock((double)sim.masterclock / (double)F_CPU);

    if(nvs_dirty) {
        nvs_dirty = false;
        host_nvs_save(nvs, sizeof(nvs));
    }

    emscripten_sleep(ms > 0.0 ? (unsigned int)ms : 0);

    pace.last_yield_ms = emscripten_get_now();
    pace.speed = host_speed();
    pull_input();
}

static bool machine_is_busy (void)
{
    return sim.input_pending ||
            plan_get_current_block() != NULL ||
             driver_delay_pending() ||
              hal.stream.get_rx_buffer_count() != 0 ||
               uart.tx_irq_enable || uart.tx_flag;
}

static void sim_pace (void)
{
    if(sim.masterclock < pace.next_check)
        return;

    pace.next_check = sim.masterclock + TICKS_PER_MS;

    double now = emscripten_get_now();
    // "As fast as possible" only applies while there is work to do - an idle
    // machine keeps wall time so the host is not spun at 100% for nothing.
    double speed = pace.speed == 0.0 && !machine_is_busy() ? 1.0 : pace.speed;

    // Pace relative to the moment the speed last changed, not to boot.
    if(speed != pace.effective) {
        pace.effective = speed;
        pace.anchor_wall_ms = now;
        pace.anchor_sim_ms = sim_ms();
    }

    if(speed > 0.0) {

        double target = pace.anchor_wall_ms + (sim_ms() - pace.anchor_sim_ms) / speed;

        if(now - target > MAX_LAG_MS) {
            pace.anchor_wall_ms = now;
            pace.anchor_sim_ms = sim_ms();
        } else if(target - now >= YIELD_AHEAD_MS) {
            sim_yield(target - now);
            return;
        }
    }

    if(now - pace.last_yield_ms >= YIELD_INTERVAL_MS)
        sim_yield(0);
}

static void sim_sample (void)
{
    bool moved = memcmp(samples.last_position, machine.steps, sizeof(samples.last_position)) != 0;
    sys_state_t state = state_get();

    if(!(samples.dirty || state != samples.last_state || (sim.masterclock >= samples.next && (moved || samples.moving))))
        return;

    double *s = &samples.data[samples.n * SAMPLE_STRIDE];
    float mpos[N_AXIS];

    system_convert_array_steps_to_mpos(mpos, sys.position);

    s[0] = (double)sim.masterclock / (double)F_CPU;
    s[1] = (double)state;
    s[2] = actuators.on ? (actuators.ccw ? -actuators.rpm : actuators.rpm) : 0.0;
    s[3] = (double)actuators.coolant;
    s[4] = (double)sys.homed.mask;
    for(uint_fast8_t i = 0; i < N_AXIS; i++) {
        s[SAMPLE_AXES + i] = (double)machine.steps[i] / (double)settings.axis[i].steps_per_mm;
        s[SAMPLE_AXES + N_AXIS + i] = (double)mpos[i];
    }

    memcpy(samples.last_position, machine.steps, sizeof(samples.last_position));
    samples.last_state = state;
    samples.moving = moved;
    samples.dirty = false;
    samples.next = sim.masterclock + samples.period;

    if(++samples.n == SAMPLE_BUF_N)
        flush_samples();
}

// Limit switches sit at the end of travel grblHAL homes towards: the maximum
// end unless the axis' $23 homing direction bit is set. They are wired the way
// $5 says, so an inverted setting means a normally closed switch.
static void update_limits (void)
{
    uint16_t hit = 0;

    machine.stepped = false;

    for(uint_fast8_t i = 0; i < N_AXIS; i++) {

        float travel = fabsf(settings.axis[i].max_travel);

        if(travel <= 0.0f)
            continue;

        float mm = (float)machine.steps[i] / settings.axis[i].steps_per_mm;

        if(settings.homing.dir_mask.mask & bit(i) ? mm <= 0.0f : mm >= travel)
            hit |= bit(i);
    }

    if(hit != machine.limits) {
        machine.limits = hit;
        mcu_gpio_in(&gpio[LIMITS_PORT0], hit ^ settings.limits.invert.mask, AXES_BITMASK);
    }
}

// Power on somewhere inside the envelope, spindle raised.
static int32_t power_on_steps (uint_fast8_t axis)
{
    float at = fabsf(settings.axis[axis].max_travel) * (axis == Z_AXIS ? 0.9f : 0.5f);

    return (int32_t)lroundf(at * settings.axis[axis].steps_per_mm);
}

void sim_machine_init (void)
{
    for(uint_fast8_t i = 0; i < N_AXIS; i++)
        machine.steps[i] = power_on_steps(i);

    machine.limits = 0;
    mcu_gpio_in(&gpio[LIMITS_PORT0], settings.limits.invert.mask, AXES_BITMASK);
    samples.dirty = true;
}

// Settings do not move the machine, but a changed envelope must still contain
// it: an axis left outside goes back to where it would have powered on.
void sim_machine_settings_changed (void)
{
    for(uint_fast8_t i = 0; i < N_AXIS; i++) {
        int32_t max = (int32_t)lroundf(fabsf(settings.axis[i].max_travel) * settings.axis[i].steps_per_mm);
        if(max > 0 && (machine.steps[i] >= max || machine.steps[i] < 0))
            machine.steps[i] = power_on_steps(i);
    }

    machine.stepped = true;
    samples.dirty = true;
}

void sim_motor_step (uint32_t step_bits, uint32_t dir_bits)
{
    for(uint_fast8_t i = 0; i < N_AXIS; i++) {
        if(step_bits & bit(i))
            machine.steps[i] += dir_bits & bit(i) ? -1 : 1;
    }

    machine.stepped = true;
}

void sim_init (void)
{
    memset(&sim, 0, sizeof(sim));
    sim.baud_ticks = F_CPU / SIM_BAUD_RATE;

    samples.period = TICKS_PER_MS;
    samples.dirty = true;

    memset(nvs, 0xFF, sizeof(nvs));
    host_nvs_load(nvs, sizeof(nvs));

    pace.speed = pace.effective = host_speed();
    pace.anchor_wall_ms = pace.last_yield_ms = emscripten_get_now();

    pull_input();
}

void sim_advance (void)
{
    static bool busy = false;

    if(busy) // an ISR ended up back in a wait hook
        return;

    busy = true;

    // The UART only needs byte slots while something is queued in either
    // direction; otherwise let the slot clock idle so the next event can be
    // a timer up to 1 ms away.
    bool serial_active = sim.input_pending || uart.tx_irq_enable || uart.tx_flag;

    if(!serial_active && sim.next_byte_tick < sim.masterclock)
        sim.next_byte_tick = sim.masterclock;

    uint64_t limit = MCU_MAX_SKIP;

    if(serial_active && sim.next_byte_tick > sim.masterclock && sim.next_byte_tick - sim.masterclock < limit)
        limit = sim.next_byte_tick - sim.masterclock;

    uint32_t skip = serial_active && sim.next_byte_tick <= sim.masterclock ? 0 : mcu_ticks_to_event((uint32_t)limit);

    if(skip) {
        mcu_skip_ticks(skip);
        sim.masterclock += skip;
    }

    sim.masterclock++;
    mcu_master_clock();

    if(serial_active && sim.masterclock >= sim.next_byte_tick) {
        // 8N1: 10 bit times per byte
        sim.next_byte_tick = sim.masterclock + sim.baud_ticks * 10;
        simulate_serial();
    }

    if(machine.stepped)
        update_limits();

    sim_sample();
    sim_pace();

    busy = false;
}

void sim_serial_out (uint8_t c)
{
    outbuf.data[outbuf.len++] = c;

    if(outbuf.len == OUTBUF_SIZE)
        flush_output();
}

int16_t sim_serial_in (void)
{
    if(inbuf.head == inbuf.tail)
        return -1;

    uint8_t c = inbuf.data[inbuf.tail];
    inbuf.tail = (inbuf.tail + 1) & (INBUF_SIZE - 1);
    sim.input_pending = inbuf.head != inbuf.tail;

    return c;
}

void sim_set_spindle (bool on, bool ccw, float rpm)
{
    if(on != actuators.on || ccw != actuators.ccw || rpm != actuators.rpm) {
        actuators.on = on;
        actuators.ccw = ccw;
        actuators.rpm = rpm;
        samples.dirty = true;
    }
}

void sim_set_coolant (uint8_t mask)
{
    if(mask != actuators.coolant) {
        actuators.coolant = mask;
        samples.dirty = true;
    }
}

uint8_t sim_nvs_get_byte (uint32_t addr)
{
    return addr < SIM_NVS_SIZE ? nvs[addr] : 0xFF;
}

void sim_nvs_put_byte (uint32_t addr, uint8_t value)
{
    if(addr < SIM_NVS_SIZE && nvs[addr] != value) {
        nvs[addr] = value;
        nvs_dirty = true;
    }
}

bool sim_nvs_memcpy_to (uint32_t dest, uint8_t *source, uint32_t size, bool with_checksum)
{
    if(dest + size + (with_checksum ? NVS_CRC_BYTES : 0) > SIM_NVS_SIZE)
        return false;

    for(uint32_t i = 0; i < size; i++)
        sim_nvs_put_byte(dest + i, source[i]);

    if(with_checksum) {
        uint16_t checksum = calc_checksum(source, size);
        sim_nvs_put_byte(dest + size, checksum & 0xFF);
#if NVS_CRC_BYTES > 1
        sim_nvs_put_byte(dest + size + 1, checksum >> 8);
#endif
    }

    return true;
}

bool sim_nvs_memcpy_from (uint8_t *dest, uint32_t source, uint32_t size, bool with_checksum)
{
    if(source + size + (with_checksum ? NVS_CRC_BYTES : 0) > SIM_NVS_SIZE)
        return false;

    memcpy(dest, &nvs[source], size);

    if(!with_checksum)
        return true;

#if NVS_CRC_BYTES == 1
    return calc_checksum(dest, size) == nvs[source + size];
#else
    return calc_checksum(dest, size) == (nvs[source + size] | (nvs[source + size + 1] << 8));
#endif
}
