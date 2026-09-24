// Picks the firmware build the engine can run: JSPI where WebAssembly stack
// switching is available (no overhead), Asyncify everywhere else.

export const jspiSupported = typeof WebAssembly.Suspending === 'function';

export async function loadFirmware() {
  const mod = jspiSupported
    ? await import('@firmware/grblhal-jspi.mjs')
    : await import('@firmware/grblhal-asyncify.mjs');
  return { factory: mod.default, variant: jspiSupported ? 'JSPI' : 'Asyncify' };
}
