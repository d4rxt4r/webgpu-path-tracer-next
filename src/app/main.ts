import './style.css';
import { createDevice } from '../gpu/device';
import { cornellScene } from '../scene/cornell';
import { attachOrbit } from './orbit';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main>
    <header><span class="eyebrow">WEBGPU / ЭТАП 02</span><h1>Спектральный рендерер</h1><p>Коробка Корнелла · диагностика пересечений</p></header>
    <div class="controls"><label>Вид <select id="view" disabled><option value="normal">Нормали</option><option value="depth">Глубина</option><option value="bvh">Обход BVH</option></select></label><button id="reset" disabled>Сброс камеры</button></div>
    <section class="viewport"><canvas aria-label="Scene intersection image"></canvas><div id="error" role="alert" hidden></div></section>
    <footer><div><strong id="status">Инициализация…</strong><p id="stats">Запрашиваем GPU-адаптер</p></div><button id="pause" disabled>Пауза</button></footer>
    <p class="note">Перетаскивание — вращение камеры, колесо — приближение. Контрольная сфера и поверхности показаны без освещения. Время включает ожидание очереди и не является GPU timestamp.</p>
  </main>`;

const canvas = document.querySelector('canvas')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const status = document.querySelector<HTMLElement>('#status')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
let userPaused = false;
const description = cornellScene();
async function start(): Promise<void> {
  // Reflection depends on GPUShaderStage, which unsupported browsers do not expose.
  if (!isSecureContext || !navigator.gpu) await createDevice();
  const { IntersectionRenderer } = await import('../render/intersection-renderer');
  const renderer = new IntersectionRenderer(canvas, info => {
    status.textContent = ({ ready: 'WebGPU готов', paused: 'Пауза', recovering: 'Восстановление GPU…', error: 'Ошибка GPU' })[info.status];
    stats.textContent = `${info.adapter} · ${info.width} × ${info.height} · ${info.triangles} треугольников / ${info.nodes} BVH узлов · ${(info.bytes / 1048576).toFixed(2)} MiB ресурсов · ${info.frames} кадров · завершение ${info.completionMs.toFixed(1)} мс`;
    canvas.dataset.frames = String(info.frames);
    pause.disabled = info.status === 'error' || info.status === 'recovering';
  }, error => {
    const panel = document.querySelector<HTMLElement>('#error')!;
    panel.hidden = false; panel.textContent = error.message;
  });
  const orbit = attachOrbit(canvas, description.camera, camera => renderer.setCamera(camera));
  document.querySelector('#reset')!.addEventListener('click', () => orbit.reset());
  document.querySelector<HTMLSelectElement>('#view')!.addEventListener('change', event => renderer.setDebugView((event.target as HTMLSelectElement).value as 'normal' | 'depth' | 'bvh'));

  pause.addEventListener('click', () => { userPaused = !userPaused; pause.textContent = userPaused ? 'Продолжить' : 'Пауза'; if (userPaused) renderer.pause(); else renderer.resume(); });
  const observer = new ResizeObserver(() => renderer.resize()); observer.observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden || userPaused) renderer.pause(); else renderer.resume(); });
  window.addEventListener('pagehide', event => {
    if (event.persisted) renderer.pause();
    else { observer.disconnect(); orbit.dispose(); renderer.dispose(); }
  });
  window.addEventListener('pageshow', event => { if (event.persisted && !document.hidden && !userPaused) renderer.resume(); });
  try {
    await renderer.setScene(description);
    await renderer.initialize();
    document.querySelector<HTMLSelectElement>('#view')!.disabled = false;
    document.querySelector<HTMLButtonElement>('#reset')!.disabled = false;
  } catch (error) { observer.disconnect(); orbit.dispose(); renderer.dispose(); throw error; }
}
void start().catch(error => {
  status.textContent = 'Ошибка запуска'; pause.disabled = true;
  const panel = document.querySelector<HTMLElement>('#error')!;
  panel.hidden = false; panel.textContent = error instanceof Error ? error.message : String(error);
});
