/** Optional queue timestamps for a bounded compute portion, excluding display. */
export class GpuTimer {
  private queries: GPUQuerySet;
  private resolved: GPUBuffer;
  private readback: GPUBuffer;
  constructor(device: GPUDevice) {
    this.queries = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolved = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readback = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }
  get bytes(): number {
    return 32;
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
  end(encoder: GPUCommandEncoder): void {
    encoder
      .beginComputePass({
        timestampWrites: { querySet: this.queries, endOfPassWriteIndex: 1 },
      })
      .end();
    encoder.resolveQuerySet(this.queries, 0, 2, this.resolved, 0);
    encoder.copyBufferToBuffer(this.resolved, 0, this.readback, 0, 16);
  }
  async read(): Promise<number> {
    await this.readback.mapAsync(GPUMapMode.READ);
    const values = new BigUint64Array(this.readback.getMappedRange());
    const ms = Number(values[1]! - values[0]!) / 1e6;
    this.readback.unmap();
    return ms;
  }
  dispose(): void {
    this.queries.destroy();
    this.resolved.destroy();
    this.readback.destroy();
  }
}
