import './style.css';
import { createDevice } from '../gpu/device';
import { cornellScene } from '../scene/cornell';
import { attachOrbit } from './orbit';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main>
    <header><span class="eyebrow">WEBGPU / ЭТАП 04</span><h1>Спектральный рендерер</h1><p>Коробка Корнелла · RGB path tracing</p></header>
    <div class="controls"><label>Вид <select id="view" disabled><option value="beauty">RGB PT</option><option value="normal">Нормали</option><option value="depth">Глубина</option><option value="bvh">Обход BVH</option></select></label><label>Разрешение <select id="resolution" disabled><option value="19200">Быстрое</option><option value="76800" selected>Среднее</option><option value="307200">640 × 480</option></select></label><label>Семплирование <select id="strategy" disabled><option value="mis">MIS</option><option value="light">Light</option><option value="bsdf">BSDF</option></select></label><label>Material <select id="material" disabled><option value="diffuse">Diffuse</option><option value="glass">Glass</option></select></label><button id="reset" disabled>Сброс камеры</button></div>
    <label class="exposure">Экспозиция <input id="exposure" type="range" min="-4" max="4" step="0.1" value="0" disabled></label>
    <section class="viewport"><canvas aria-label="Progressive RGB path traced image"></canvas><div id="error" role="alert" hidden></div></section>
    <footer><div><strong id="status">Инициализация…</strong><p id="stats">Запрашиваем GPU-адаптер</p></div><button id="pause" disabled>Пауза</button></footer>
    <p class="note">Перетаскивание — вращение камеры, колесо — приближение. Изображение постепенно накапливает свет; движение камеры начинает накопление заново. Материал контрольной сферы можно переключить на стекло. Время включает ожидание очереди и не является GPU timestamp.</p>
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
    stats.textContent = `${info.adapter} · ${info.width} × ${info.height} · ${info.triangles} треугольников · ${(info.bytes / 1048576).toFixed(2)} MiB · ${info.samples} spp · ${info.tile}/${info.tiles} tiles · завершение ${info.completionMs.toFixed(1)} мс`;
    canvas.dataset.frames = String(info.frames);
    canvas.dataset.samples = String(info.samples);
    canvas.dataset.tile = String(info.tile);
    pause.disabled = info.status === 'error' || info.status === 'recovering';
  }, error => {
    const panel = document.querySelector<HTMLElement>('#error')!;
    panel.hidden = false; panel.textContent = error.message;
  });
  let currentCamera = description.camera;
  document.querySelector<HTMLSelectElement>('#material')!.addEventListener('change', event => {
    const scene = cornellScene((event.target as HTMLSelectElement).value as 'diffuse' | 'glass');
    scene.camera = currentCamera;
    renderer.setSettings({ maxDepth: 32 });
    void renderer.setScene(scene).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const panel = document.querySelector<HTMLElement>('#error')!;
      panel.hidden = false; panel.textContent = String(error);
    });
  });
  const orbit = attachOrbit(canvas, description.camera, camera => { currentCamera = camera; renderer.setCamera(camera); });
  document.querySelector('#reset')!.addEventListener('click', () => orbit.reset());
  document.querySelector<HTMLSelectElement>('#view')!.addEventListener('change', event => renderer.setDebugView((event.target as HTMLSelectElement).value as 'normal' | 'depth' | 'bvh' | 'beauty'));
  document.querySelector<HTMLSelectElement>('#resolution')!.addEventListener('change', event => renderer.setSettings({ maxPixels: Number((event.target as HTMLSelectElement).value) }));
  document.querySelector<HTMLSelectElement>('#strategy')!.addEventListener('change', event => renderer.setSettings({ strategy: (event.target as HTMLSelectElement).value as 'mis' | 'light' | 'bsdf' }));
  document.querySelector<HTMLInputElement>('#exposure')!.addEventListener('input', event => renderer.setExposure(Number((event.target as HTMLInputElement).value)));
  renderer.setDebugView('beauty');
  renderer.setSettings({ maxPixels: 320 * 240 });

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
    document.querySelectorAll<HTMLSelectElement | HTMLButtonElement | HTMLInputElement>('#view, #reset, #resolution, #strategy, #exposure, #material').forEach(control => { control.disabled = false; });
  } catch (error) { observer.disconnect(); orbit.dispose(); renderer.dispose(); throw error; }
}
void start().catch(error => {
  status.textContent = 'Ошибка запуска'; pause.disabled = true;
  const panel = document.querySelector<HTMLElement>('#error')!;
  panel.hidden = false; panel.textContent = error instanceof Error ? error.message : String(error);
});
