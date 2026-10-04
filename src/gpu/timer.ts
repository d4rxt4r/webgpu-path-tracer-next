import { TRANSPORT_DIAGNOSTIC_BYTES } from "../render/transport-diagnostics";
/** Optional queue timestamps for a bounded compute portion, excluding display. */
export class GpuTimer {
  private queries: GPUQuerySet;
  private resolved: GPUBuffer;
  constructor(device: GPUDevice) {
    this.queries = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolved = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }
  get bytes(): number {
    return 16;
  }
  begin(encoder: GPUCommandEncoder): void {
    encoder
      .beginComputePass({
        timestampWrites: {
          querySet: this.queries,
          beginningOfPassWriteIndex: 0,
        },
      })
      .end();
  }
  end(encoder: GPUCommandEncoder, readback: GPUBuffer): void {
    encoder
      .beginComputePass({
        timestampWrites: { querySet: this.queries, endOfPassWriteIndex: 1 },
      })
      .end();
    encoder.resolveQuerySet(this.queries, 0, 2, this.resolved, 0);
    encoder.copyBufferToBuffer(this.resolved, 0, readback, TRANSPORT_DIAGNOSTIC_BYTES, 16);
  }
  read(mapped: ArrayBuffer): number {
    const values = new BigUint64Array(mapped, TRANSPORT_DIAGNOSTIC_BYTES, 2);
    const ms = Number(values[1]! - values[0]!) / 1e6;
    return ms;
  }
  dispose(): void {
    this.queries.destroy();
    this.resolved.destroy();
  }
}
