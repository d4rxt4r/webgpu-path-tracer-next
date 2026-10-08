# Numeric input beyond slider scales

The slider keeps its original scale. The numeric field commits on change and is the canonical value for rendering, links, JSON metadata and UI refresh. Moving the slider replaces the extended value with a value on that scale. Middle click restores the original default.

Extended fields: GPU memory budget, area-light power, environment strength, lava power, exposure (16 EV), denoiser strength (10), SPPM radius (0.5 m), texture width (1), neutral walls (1), FOV (less than 179 degrees). Other limits are unchanged. Brightness must fit finite GPU parameters; the memory budget must fit safe JavaScript byte arithmetic. Device allocation limits remain enforced.

Validation on 2026-10-09:

- 144 CPU tests passed, including numeric bounds and rejection of overflowing environment parameters before GPU writes.
- TypeScript and Vite production build passed.
- Connected Chrome, Intel gen-12lp: 4096, 8192 and 16384 MiB accepted, slider stayed at 4096, custom profile selected. URL serialization/restoration retained 16384. Middle reset restored 192. Invalid input restored the accepted value; slider interaction returned to its ordinary range.
- All ten extended fields round-tripped through link serialization/restoration in browser DOM. Consumer callbacks saw committed values before applying settings.
- RGB PT at 129 x 147 used 2.00 MiB. Observed GPU timestamps for the three budgets were 8.78/7.27/7.21 ms; corresponding completion times were 19.0/15.1/13.6 ms. These are individual UI observations, not a controlled speed benchmark.
- Spectral SPPM with 16384 MiB: 129 x 147, 5.72 MiB, 12 iterations, 196608 photons; observed GPU timestamp 5.11 ms and completion 8.0 ms. No JavaScript/WebGPU errors; Chrome emitted its existing Windows powerPreference warning.

The added Playwright regression covers actual link reload, refresh, rejection and middle reset; it was not run as a separate browser suite. Connected-browser checks above were run directly. Increasing the budget does not allocate that amount or guarantee higher FPS.
