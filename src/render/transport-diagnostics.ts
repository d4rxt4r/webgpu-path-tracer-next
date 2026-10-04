export const TRANSPORT_DIAGNOSTIC_BYTES = 64;
export const COMPUTE_READBACK_BYTES = TRANSPORT_DIAGNOSTIC_BYTES + 16;

/** Copy before unmapping the shared GPU timestamp/diagnostic readback. */
export function transportDiagnostic(mapped: ArrayBuffer): Uint32Array {
  return new Uint32Array(mapped, 0, TRANSPORT_DIAGNOSTIC_BYTES / 4).slice();
}

export function transportFailure(words: Uint32Array, total = words[0]!): string {
  const kind = ["unknown", "intersection", "medium", "material", "hash", "non-finite"][words[2]!] ?? "unknown";
  const phase = ["unknown", "camera", "photon", "gather", "update", "PT"][words[3]!] ?? "unknown";
  const indexKind = phase === "photon" ? "photon" : "pixel";
  const triangle = (value: number) => value === 0xffffffff ? "none" : String(value);
  return `GPU transport failed for ${total} operations: ${kind}; phase=${phase}, iteration=${words[4]}, ${indexKind}=${words[5]}, depth=${words[6]}, triangle=${triangle(words[7]!)}, medium=${triangle(words[8]!)}, seed=${words[9]}, size=${words[10]}x${words[11]}.`;
}

// 65,536 pending invocations cover a complete 256-square tile. Larger
// dispatches use a dense fallback rather than dropping overflowed work.
export const TRANSPORT_QUEUE_BYTES = 128 + 65536 * 4;
export function clearTransportQueue(encoder: GPUCommandEncoder, errors: GPUBuffer): void {
  encoder.clearBuffer(errors, 48, 20);
}
export function encodeTransportRepair(encoder: GPUCommandEncoder, errors: GPUBuffer, indirect: GPUBuffer, pipeline: GPUComputePipeline, group: GPUBindGroup): void {
  encoder.copyBufferToBuffer(errors, 52, indirect, 0, 12);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroupsIndirect(indirect, 0);
  pass.end();
}
