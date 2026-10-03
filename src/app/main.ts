import './style.css';
import { FoundationRenderer } from '../render/foundation';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main>
    <header><span class="eyebrow">WEBGPU / ЭТАП 01</span><h1>Спектральный рендерер</h1><p>Основание движка · проверка compute-to-canvas</p></header>
    <section class="viewport"><canvas aria-label="WebGPU diagnostic image"></canvas><div id="error" role="alert" hidden></div></section>
    <footer><div><strong id="status">Инициализация…</strong><p id="stats">Запрашиваем GPU-адаптер</p></div><button id="pause" disabled>Пауза</button></footer>
    <p class="note">Диагностический кадр. Трассировка света и сцена Корнелла появятся на следующих этапах. Время ниже включает ожидание очереди и не является GPU timestamp.</p>
  </main>`;

const canvas = document.querySelector('canvas')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const status = document.querySelector<HTMLElement>('#status')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
let userPaused = false;
const renderer = new FoundationRenderer(canvas, info => {
  status.textContent = ({ ready: 'WebGPU готов', paused: 'Пауза', recovering: 'Восстановление GPU…', error: 'Ошибка GPU' })[info.status];
  stats.textContent = `${info.adapter} · ${info.width} × ${info.height} · ${(info.bytes / 1048576).toFixed(2)} MiB ресурсов · ${info.frames} кадров · завершение ${info.completionMs.toFixed(1)} мс`;
  canvas.dataset.frames = String(info.frames);
  pause.disabled = info.status === 'error' || info.status === 'recovering';
}, error => {
  const panel = document.querySelector<HTMLElement>('#error')!;
  panel.hidden = false; panel.textContent = error.message;
});

pause.addEventListener('click', () => { userPaused = !userPaused; pause.textContent = userPaused ? 'Продолжить' : 'Пауза'; if (userPaused) renderer.pause(); else renderer.resume(); });
const observer = new ResizeObserver(() => renderer.resize()); observer.observe(canvas);
document.addEventListener('visibilitychange', () => { if (document.hidden || userPaused) renderer.pause(); else renderer.resume(); });
window.addEventListener('pagehide', () => { observer.disconnect(); renderer.dispose(); });
void renderer.initialize().catch(error => { renderer.dispose(); status.textContent = 'WebGPU недоступен'; const panel = document.querySelector<HTMLElement>('#error')!; panel.hidden = false; panel.textContent = String(error instanceof Error ? error.message : error); });
