// SPDX-License-Identifier: LGPL-3.0-or-later
// Picks the firmware build the engine can run: JSPI where WebAssembly stack
// switching is available (no overhead), Asyncify everywhere else.

export const jspiSupported = typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function';

// variant: 'auto' | 'jspi' | 'asyncify'
export async function loadFirmware(variant = 'auto') {
  const jspi = variant === 'jspi' || (variant === 'auto' && jspiSupported);
  const mod = jspi ? await import('../firmware/grblhal-jspi.mjs') : await import('../firmware/grblhal-asyncify.mjs');
  return { factory: mod.default, variant: jspi ? 'jspi' : 'asyncify' };
}
