/*
  sim.h - single threaded hardware simulation and host (JS) glue for the wasm target

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

#ifndef _SIM_H_
#define _SIM_H_

#include <stdint.h>
#include <stdbool.h>

#ifndef F_CPU
#define F_CPU 16000000
#endif

#define SIM_BAUD_RATE 115200

// Tool length (stick-out below the collet face, mm) until the host sets one.
#define SIM_DEFAULT_TOOL_LENGTH 22.0f
#define SIM_NVS_SIZE 4096

// There is only one thread: grblHAL's foreground code. The simulated MCU
// (timers, GPIO, UART) is advanced from the hooks grblHAL calls whenever it
// waits or polls - grbl.on_execute_realtime and hal.delay_ms. Foreground code
// therefore takes zero simulated time and "interrupts" fire between two passes
// of the main loop, at exactly the simulated tick they are due.

typedef struct {
    uint64_t masterclock;       // simulated CPU ticks since boot
    uint64_t next_byte_tick;    // next UART byte slot
    uint32_t baud_ticks;        // ticks per bit
    uint32_t grbl_pulse;        // main loop heartbeat, 0 until booted
    bool input_pending;         // bytes waiting in the host input queue
} sim_t;

extern sim_t sim;

void sim_init (void);

// Advances the simulated hardware up to and including the next event
// (timer IRQ, GPIO IRQ or UART byte slot), bounded to 1 ms of simulated time.
// Yields to the host event loop when simulated time runs ahead of wall time.
void sim_advance (void);

// UART side, called from the simulated UART in mcu.c
void sim_serial_out (uint8_t c);
int16_t sim_serial_in (void); // -1 if no data

// Physical machine: motor positions integrated from the step/dir outputs,
// independent of what grblHAL believes (sys.position), and the limit
// switches they trip. Call sim_machine_init() once settings are loaded.
void sim_machine_init (void);
void sim_machine_settings_changed (void);
void sim_motor_step (uint32_t step_bits, uint32_t dir_bits);

// Actuator state reported by the driver for the host visualisation
void sim_set_spindle (bool on, bool ccw, float rpm);
void sim_set_coolant (uint8_t mask);

// Physical NVS (EEPROM emulation), persisted by the host
uint8_t sim_nvs_get_byte (uint32_t addr);
void sim_nvs_put_byte (uint32_t addr, uint8_t value);
bool sim_nvs_memcpy_to (uint32_t dest, uint8_t *source, uint32_t size, bool with_checksum);
bool sim_nvs_memcpy_from (uint8_t *dest, uint32_t source, uint32_t size, bool with_checksum);

#endif
