// SPDX-License-Identifier: LGPL-3.0-or-later
// Layout of one position sample (onSamples): `stride` doubles per sample, of
// which the first AXES are these fields, then N physical axis positions (mm,
// integrated from the step/dir outputs, 0 = minimum end of travel), then N
// grblHAL machine positions (MPos, mm). N = (stride - SAMPLE.AXES) / 2.
export const SAMPLE = Object.freeze({
  TIME: 0,      // simulated seconds
  STATE: 1,     // grblHAL sys_state_t bits (0 = idle)
  RPM: 2,       // spindle rpm, negative = counter-clockwise, 0 = off
  COOLANT: 3,   // coolant mask: 1 = flood, 2 = mist
  HOMED: 4,     // homed axes mask
  AXES: 5,
});
