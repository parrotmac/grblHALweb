// SPDX-License-Identifier: LGPL-3.0-or-later
// Layout of one position sample (onSamples): `stride` doubles per sample, of
// which the first AXES are these fields, then N physical axis positions (mm,
// integrated from the step/dir outputs, 0 = minimum end of travel), then N
// grblHAL machine positions (MPos, mm). N = (stride - SAMPLE.AXES) / 2.
//
// Besides one every simulated millisecond while moving and one on every
// change of state, spindle or coolant, there is a sample wherever a stepper
// block ends and the next begins. Within a block the tool moves in a straight
// line, so the samples trace the path exactly. LINE and MOTION describe the
// block that moved the tool to the sample.
export const SAMPLE = Object.freeze({
  TIME: 0,      // simulated seconds
  STATE: 1,     // grblHAL sys_state_t bits (0 = idle)
  RPM: 2,       // spindle rpm, negative = counter-clockwise, 0 = off
  COOLANT: 3,   // coolant mask: 1 = flood, 2 = mist
  HOMED: 4,     // homed axes mask
  LINE: 5,      // program line number (the N word), 0 = none
  MOTION: 6,    // motion flags, see MOTION_RAPID
  TOOL: 7,      // selected tool number (T, after M6)
  AXES: 8,
});

export const MOTION_RAPID = 1; // a G0 move

// The layout of protocol 1's samples message (PROTOCOL.md), which has only the
// first five fields: TIME to HOMED, then the axes.
export const PROTOCOL_SAMPLE_FIELDS = 5;

export function toProtocolSamples(data, count, stride) {
  const n = (stride - SAMPLE.AXES) / 2;
  const outStride = PROTOCOL_SAMPLE_FIELDS + 2 * n;
  const out = new Float64Array(count * outStride);
  for (let i = 0; i < count; i++) {
    const s = i * stride, o = i * outStride;
    out.set(data.subarray(s, s + PROTOCOL_SAMPLE_FIELDS), o);
    out.set(data.subarray(s + SAMPLE.AXES, s + stride), o + PROTOCOL_SAMPLE_FIELDS);
  }
  return { data: out, count, stride: outStride };
}
