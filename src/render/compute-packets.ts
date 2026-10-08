export type ComputePhase =
  | "pt"
  | "camera"
  | "photon"
  | "gather"
  | "update"
  | "debug";

/** Bounds submissions by predicted GPU time, without changing sample partitioning. */
export class PacketBudget {
  private costs: Record<ComputePhase, number> = {
    pt: 4,
    camera: 4,
    photon: 8,
    gather: 0.08,
    update: 4,
    debug: 8,
  };
  steps(phase: ComputePhase, interacting: boolean): number {
    if (interacting || phase === "debug" || phase === "update") return 1;
    return Math.max(1, Math.min(128, Math.ceil(8 / this.costs[phase])));
  }
  observe(
    phase: ComputePhase,
    steps: number,
    gpuMs: number | undefined,
    completionMs: number,
  ): void {
    const duration = gpuMs && gpuMs > 0 ? gpuMs : completionMs;
    if (!Number.isFinite(duration) || duration <= 0 || steps < 1) return;
    const measured = Math.max(0.005, duration / steps);
    // Respond immediately to expensive work, recover throughput gradually.
    const old = this.costs[phase];
    this.costs[phase] =
      measured > old ? measured : old * 0.75 + measured * 0.25;
  }
}

/** Change the grid only between complete sweeps, keeping every pixel sampled once. */
export class TileBudget {
  size: number;
  constructor(initial = 64, private readonly minimum = 16) {
    this.size = initial;
  }
  observe(gpuMs: number, tiles: number): void {
    if (!(gpuMs > 0) || tiles < 1) return;
    const perTile = gpuMs / tiles;
    if (perTile > 16)
      this.size = Math.max(this.minimum, Math.floor(this.size / 2 / 8) * 8);
    else if (perTile < 4) this.size = Math.min(256, this.size * 2);
  }
}

/** Immutable parameter snapshots copied in command order, not queue.writeBuffer order. */
export class PacketUniforms {
  private buffers: GPUBuffer[];
  private index = 0;
  private offset = 0;
  private readonly stride: number;
  private readonly capacity = 256;
  constructor(private device: GPUDevice, maxUniformBytes = 256) {
    const alignment = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
    this.stride = Math.ceil(maxUniformBytes / alignment) * alignment;
    this.buffers = Array.from({ length: 2 }, (_, i) =>
      device.createBuffer({
        label: `Compute packet uniforms ${i}`,
        size: this.stride * this.capacity,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
    );
  }
  get bytes(): number {
    return this.buffers.reduce((sum, b) => sum + b.size, 0);
  }
  begin(): void {
    this.index = (this.index + 1) % this.buffers.length;
    this.offset = 0;
  }
  write(
    encoder: GPUCommandEncoder,
    target: GPUBuffer,
    data: ArrayBuffer,
  ): void {
    if (
      data.byteLength > this.stride ||
      this.offset + this.stride > this.buffers[this.index]!.size
    )
      throw new Error("Compute packet uniform capacity exceeded");
    const source = this.buffers[this.index]!;
    this.device.queue.writeBuffer(source, this.offset, data);
    encoder.copyBufferToBuffer(source, this.offset, target, 0, data.byteLength);
    this.offset += this.stride;
  }
  dispose(): void {
    this.buffers.forEach((buffer) => buffer.destroy());
  }
}
