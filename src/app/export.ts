import type { RenderCapture } from "../render/intersection-renderer";

/** Bottom-up little-endian PFM; signed raw radiance is preserved. */
export function encodePfm(
  capture: Pick<RenderCapture, "width" | "height" | "linearRgb">,
): Uint8Array<ArrayBuffer> {
  const { width, height, linearRgb } = capture;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    linearRgb.length !== width * height * 3 ||
    !linearRgb.every(Number.isFinite)
  )
    throw new Error("Invalid PFM image");
  const header = new TextEncoder().encode(`PF\n${width} ${height}\n-1.0\n`);
  const bytes = new Uint8Array(header.length + width * height * 12),
    view = new DataView(bytes.buffer);
  bytes.set(header);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++)
        view.setFloat32(
          header.length + ((y * width + x) * 3 + c) * 4,
          linearRgb[((height - 1 - y) * width + x) * 3 + c]!,
          true,
        );
  return bytes;
}
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
