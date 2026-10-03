import type { CameraDescription, Vec3 } from '../scene/types';

export function attachOrbit(canvas: HTMLCanvasElement, initial: CameraDescription, update: (camera: CameraDescription) => void): { reset(): void; set(camera: CameraDescription): void; dispose(): void } {
  let camera = structuredClone(initial);
  let pointer: { id: number; x: number; y: number } | undefined;
  const emit = (): void => update(structuredClone(camera));
  const spherical = (): [number, number, number] => {
    const delta = camera.position.map((v, i) => v - camera.target[i]!);
    const radius = Math.hypot(...delta);
    return [radius, Math.atan2(delta[0]!, delta[2]!), Math.acos(delta[1]! / radius)];
  };
  const position = (radius: number, theta: number, phi: number): Vec3 => camera.target.map((v, i) => v + radius * [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)][i]!) as Vec3;
  const down = (event: PointerEvent): void => { if (event.button !== 0 || pointer) return; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); };
  const move = (event: PointerEvent): void => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const [radius, theta, phi] = spherical();
    camera.position = position(radius, theta - (event.clientX - pointer.x) * 0.005, Math.max(0.05, Math.min(Math.PI - 0.05, phi - (event.clientY - pointer.y) * 0.005)));
    pointer.x = event.clientX; pointer.y = event.clientY; emit();
  };
  const up = (event: PointerEvent): void => { if (pointer?.id === event.pointerId) { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); pointer = undefined; } };
  const wheel = (event: WheelEvent): void => {
    event.preventDefault(); const [radius, theta, phi] = spherical();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    camera.position = position(Math.max(0.25, Math.min(12, radius * Math.exp(Math.max(-2, Math.min(2, delta * 0.001))))), theta, phi); emit();
  };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('lostpointercapture', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  return {
    reset(): void { camera = structuredClone(initial); emit(); },
    set(next): void { camera = structuredClone(next); emit(); },
    dispose(): void { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('lostpointercapture', up); canvas.removeEventListener('wheel', wheel); },
  };
}
