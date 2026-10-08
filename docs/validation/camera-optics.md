# Camera distance and thin-lens depth of field

Validation date: 2026-10-08. Connected Chrome, Intel gen-12lp.

The camera supports 0.25–100 m with logarithmic distance controls. Optional
`CameraDescription.depthOfField` stores diameter in metres, focus distance in
metres, world-space focus points and aperture rotation in degrees. Missing optics
remain pinhole. The UI displays aperture diameter in millimetres. Camera reset
restores the original pose and disables depth of field.

PT and SPPM camera rays share `transport/camera.wgsl`. Sobol dimensions 510/511
are reserved for equal-area lens sampling. PT/camera bounce dimensions at the
supported maximum depth 64 end below 510; photon sampling remains unchanged.
The zero-radius branch returns the previous ray expression without lens samples.
Normal, depth and BVH diagnostics retain their pinhole rays.

Before accepting a camera, its bounding aperture disk is tested against every
volumetric glass boundary intersecting its plane. A rejected camera preserves the
previous accepted camera. Fully contained disks use the existing camera medium
classification. Picking uses the packed CPU BVH and the central ray of the actual
render pixel, including its aspect ratio; glass is pickable.

The prepared-cache implementation hash includes `layouts.wgsl`, so the changed
272-byte camera uniform invalidates previous prepared entries. Packet snapshots
are sized from that reflected layout, with GPU alignment retained.

## Evidence

- CPU tests cover log scales, defaults, focus projection, points behind the camera,
  aperture area moments, picking, interior/exterior/crossing glass disks and PBRT
  lens export/rejection. Existing reflected-layout tests were updated, and packet
  tests exercise the larger uniform.
- [Connected-browser UI checks](camera-optics-ui.json) cover number entry, sliders
  and wheel at 12/25/100 m, manual and picked focus during camera movement,
  cancellation, polygon controls, middle-button reset, denoise availability,
  disabled-value preservation, link restoration, Preview/Quality and rejection
  at a glass boundary. The clipboard sink was intercepted to capture the real
  copy handler's URL; operating-system clipboard permissions were not tested.
- [GPU matrix](camera-optics-gpu.json): 48×48, seed 17, depth 8, 16 PT samples or
  SPPM iterations, 1024 photons/iteration, batch 512. RGB and spectral modes were
  tested with disabled/zero/circular/polygonal lenses and repeated seeds.
  Transport errors and nonfinite values: zero in all cases.
- PT disabled and zero lenses exactly match an independently compiled kernel
  containing the previous pinhole expression. SPPM raw differences are at most
  2.98e-8, consistent with floating-point photon accumulation order; all disabled,
  zero and repeat comparisons are identical after rgba16float rounding. This is
  a display equality claim, not a claim of bitwise deterministic raw SPPM sums.
- [Lens geometry](camera-optics-rays.json): 4096 rays per configuration, circle and
  3/6/12-blade polygons, 20 and 100 mm diameters. Focus plane error is below
  2.6e-7 m. Near and far offsets agree; five times the aperture diameter produces
  five times the RMS blur radius. The lens plane offset is exactly zero.
- [Denoise matrix](camera-optics-denoise.json): 8118 checks over all three filters,
  RGB/spectral and stored glass modes. Image-only output is invariant when normals,
  depth, glass sign and sky guides are changed. Glass is filtered even when the
  stored glass mode is off; comparison and zero blend preserve the original.
- [Glass replay](camera-optics-glass.json): camera inside nested glass, 20 mm
  polygonal aperture, RGB and spectral SPPM, 4×4, two iterations, seed 17,
  depth 8, 256 photons/iteration. Common and precise passes match exactly,
  with zero transport errors and nonfinite values.
- [Visual contact sheet](camera-optics.png): pinhole, 20 mm circle, 100 mm circle,
  100 mm hexagon in the four transport/integrator combinations. Reinhard and sRGB
  display mapping, identical seed/resolution/sample counts. These small, noisy
  captures are regression evidence, not a converged photographic bokeh reference.

GPU timestamps and render completion times are recorded separately in the matrix.
SPPM `totalMs` also includes setup/compilation and must not be compared with render
completion time. These local, small-scene timings establish no general speed claim.

Selected focus points remain fixed in world coordinates. PBRT supports circular
optics only; active polygons are rejected explicitly. Sensor size/focal length,
motion blur, distortion, chromatic aberration and autoexposure are outside scope.
