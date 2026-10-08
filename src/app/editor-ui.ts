import { CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX, FOCUS_DISTANCE_MIN, FOCUS_DISTANCE_MAX } from "../scene/camera";
import { wearEffects, wearCommonFields, wearDetailFields, defaultWearEffect } from "../scene/surface-wear";
import { arrangementEditor, environmentEditor } from './environment-ui';
import { profileLabels } from "./profiles";
import { settingsLimits } from "../render/settings-limits";

const range = (
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
): string =>
  `<label class="range"><span class="field"><span>${label}</span><input id="${id}-value" type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-default="${value}" disabled></span><input id="${id}" type="range" aria-label="${label}" min="${min}" max="${max}" step="${step}" value="${value}" data-default="${value}" disabled></label>`;
const logRange = (id: string, label: string, min: number, max: number, value: number): string =>
 `<label class="range"><span class="field"><span>${label}</span><input id="${id}" type="number" min="${min}" max="${max}" step="any" value="${value}" data-default="${value}" disabled></span><input type="range" data-log-for="${id}" aria-label="${label}" min="0" max="1000" step="1" disabled></label>`;
const opticsEditor = (): string => '<label class="check"><input id="dof-enabled" type="checkbox" disabled>Глубина резкости</label><div id="dof-settings" hidden>' +
 range('aperture-diameter', 'Размытие / диаметр диафрагмы, мм', 0, 100, .1, 20) +
 select('focus-mode', 'Фокус', '<option value="target">Центр вращения</option><option value="manual">Ручная дистанция</option><option value="point">Выбранная точка</option>') +
 '<div id="manual-focus">' + logRange('focus-distance', 'Дистанция фокуса, м', FOCUS_DISTANCE_MIN, FOCUS_DISTANCE_MAX, 3.7) + '</div><button id="pick-focus" type="button" disabled>Выбрать фокус</button><p id="focus-status" class="hint" role="status"></p>' +
 select('aperture-shape', 'Боке', '<option value="circle">Круг</option><option value="polygon">Многоугольник</option>') + '<div id="polygon-settings">' + range('aperture-blades', 'Лепестки', 3, 12, 1, 6) + range('aperture-rotation', 'Поворот, °', 0, 360, 1, 0) + '</div></div><p id="camera-status" class="hint" role="alert" hidden></p>';
const select = (id: string, label: string, options: string): string =>
  `<label class="field"><span>${label}</span><select id="${id}" disabled>${options}</select></label>`;
const group = (label: string, body: string, open = false): string =>
  `<details ${open ? "open" : ""}><summary>${label}</summary><div class="group">${body}</div></details>`;
const surfaceWearEditor = (): string => wearEffects.map(name => {
  const id = `wear-${name}`, defaults = defaultWearEffect(name);
  const label = {scratches: "Царапины", scuffs: "Потёртости", fingerprints: "Отпечатки пальцев"}[name];
  const fields = (advanced: boolean) => (advanced ? wearDetailFields[name] : wearCommonFields).map(f =>
    range(`${id}-${f.key}`, f.label, f.min, f.max, f.step, Number(defaults[f.key]))).join("");
  return `<label class="check"><input id="${id}-enabled" type="checkbox" disabled>${label}</label>
    <div id="${id}-settings" class="wear-settings" hidden>` +
    select(`${id}-space`, "Размер рисунка", '<option value="model">Относительно модели</option><option value="scene">В единицах сцены (м)</option>') +
    `<label class="range"><span class="field"><span>Масштаб рисунка</span><input id="${id}-scale" type="number" min="0.05" max="20" step="any" value="1" data-default="1" disabled></span><input type="range" data-log-for="${id}-scale" aria-label="Масштаб рисунка" min="0" max="1000" step="1" value="500" disabled></label>` +
    fields(false) + `<button type="button" data-wear-seed="${name}" disabled>Новый seed</button>` +
    group("Подробные настройки", fields(true)) + '</div>';
}).join("");
function denoiseEditor(): string {
  return '<label class="check"><input id="denoiser" type="checkbox" disabled>Подавление шума</label>' +
    select("denoise-algorithm", "Фильтр", '<option value="atrous">À-trous</option><option value="bilateral">Bilateral</option><option value="nlm">NLM — готовый кадр</option>') +
    range("denoise-passes", "Проходы фильтра", 1, 5, 1, 3) + range("denoise-strength", "Сила фильтра", .1, 5, .1, 2) +
    range("denoise-blend", "Доля денойза, %", 0, 100, 1, 100) + range("denoise-radius", "Радиус поиска, px", 1, 5, 1, 2) +
    select("glass-mode", "Денойз стекла", '<option value="off">Без фильтра</option><option value="surface">По поверхности</option><option value="image">По изображению</option>') +
    range("glass-strength", "Сила для стекла", .1, 5, .1, 1) +
    group("Защита границ", range("denoise-normal", "Защита нормалей", 0, 128, 1, 32) + range("denoise-depth", "Допуск глубины", .001, .1, .001, .015)) +
    '<label class="check"><input id="denoise-compare" type="checkbox" disabled>Сравнить: слева оригинал</label>' + range("denoise-split", "Положение разделителя, %", 0, 100, 1, 50) +
    '<button id="apply-nlm" type="button" disabled>Применить NLM</button><p id="denoise-status" class="hint" role="status"></p>';
}
export function renderEditor(controlScene: boolean): string {
  return `
<main class="editor">
  <header class="topbar"><div class="brand"><h1>WebGPU Path Tracer</h1><span>WebGPU · Cornell / Suzanne / Buddha</span></div><div class="top-actions"><button id="reset" disabled>Сброс камеры</button><button id="pause" disabled>Пауза</button></div></header>
  <div class="workspace">
    <section class="viewport-area"><div class="viewport-toolbar"><div class="profile-buttons"><button data-profile="preview" disabled>Preview</button><button data-profile="reference" disabled>Reference</button><button data-profile="quality" disabled>Quality</button></div></div>
      <div class="viewport"><canvas aria-label="Progressive path traced image"></canvas><div class="viewport-overlay"><strong id="scene-name">Suzanne</strong><span id="activity">Подготовка сцены…</span><span id="progress">0 samples</span></div><div id="error" role="alert" hidden><span id="error-message"></span><button id="error-dismiss" type="button" aria-label="Закрыть сообщение об ошибке">Закрыть</button></div></div>
      <div class="viewport-help">ЛКМ — вращение · Зажатое колесо — перемещение · Колесо — приближение · Настройки применяются автоматически</div>
    </section>
    <aside class="inspector" aria-label="Настройки сцены"><div class="inspector-title">Настройки <button id="copy-link" type="button" title="Скопировать ссылку" aria-label="Скопировать ссылку" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></svg></button></div><p id="share-status" role="status" class="share-status" hidden></p><div class="view-setting"><label class="field"><span>Вид</span><select id="view" aria-label="Вид" disabled><option value="beauty">Изображение</option><option value="normal">Нормали</option><option value="depth">Глубина</option><option value="bvh">Обход BVH</option><option value="wavelength">Длина волны</option><option value="path-length">Длина PT-пути</option><option value="photon-density">Плотность фотонов</option><option value="material">Материалы</option></select></label></div>
      ${group("Рендер", select("profile", "Режим", Object.entries(profileLabels).map(([id, label]) => `<option value="${id}">${label}</option>`).join("") + '<option value="custom">Вручную</option>') + select("mode", "Перенос", '<option value="rgb">RGB</option><option value="spectral">Спектральный</option>') + select("integrator", "Интегратор", '<option value="pt">Path tracing</option><option value="sppm">SPPM</option>') + select("resolution", "Пиксельный бюджет", '<option value="19200">160 × 120</option><option value="76800">320 × 240</option><option value="307200">640 × 480</option><option value="691200">960 × 720</option><option value="2073600">1920 × 1080</option><option value="3686400">2560 × 1440</option><option value="8294400">3840 × 2160</option>') + range("max-depth", "Глубина пути", 1, settingsLimits.maxDepth, 1, 32) + select("strategy", "Семплирование", '<option value="mis">MIS</option><option value="light">Light only</option><option value="bsdf">BSDF only</option>') + '<label class="field"><span>Seed</span><input id="seed" type="number" min="0" max="4294967295" step="1" value="1" disabled></label><label class="field"><span>Цель samples / iter.</span><input id="sample-limit" type="number" min="0" max="1048576" step="1" value="0" disabled></label><label class="check"><input id="auto-preview" type="checkbox" checked disabled>Preview при движении камеры</label>', true)}
      ${group("Камера", range("fov", "Вертикальный FOV, °", 15, 90, 1, 40) + logRange("camera-distance", "Дистанция, м", CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX, 3.7) + opticsEditor())}
      ${group("Сцена и свет", arrangementEditor() + select("scene", "Объект", '<option value="suzanne-high-poly">Suzanne high poly</option><option value="suzanne">Suzanne</option><option value="rastagotchi">Rastagotchi</option><option value="buddha">Happy Buddha</option><option value="control">Контрольная сфера</option>') + '<button id="import-obj" disabled>Загрузить OBJ</button><input id="obj-file" type="file" accept=".obj" hidden><label class="check"><input id="repair-obj" type="checkbox" checked disabled>Замкнуть модель</label><p id="obj-status" role="status" class="hint"></p>' + range("object-scale", "Масштаб объекта", 0.25, 1.4, 0.01, 1) + range("object-x", "Позиция X, м", -0.35, 0.35, 0.01, 0) + range("object-y", "Позиция Y, м", 0.5, 1.3, 0.01, controlScene ? 0.65 : 1) + range("object-z", "Позиция Z, м", -0.35, 0.35, 0.01, 0) + range("object-rotation-x", "Поворот X, °", -180, 180, 1, 0) + range("object-rotation", "Поворот Y, °", -180, 180, 1, 0) + range("object-rotation-z", "Поворот Z, °", -180, 180, 1, 0) + range("light-power", "Яркость света", 0, 40, 0.1, 12) + range("light-size", "Размер света, м", 0.1, 1.2, 0.01, 0.6) + range("light-x", "Свет X, м", -0.35, 0.35, 0.01, 0) + range("light-z", "Свет Z, м", -0.35, 0.35, 0.01, 0) + range("wall-neutral", "Нейтральные стены", 0.05, 0.95, 0.01, 0.73) + range("wall-red", "Красная стена ×", 0.1, 1.5, 0.01, 1) + range("wall-green", "Зелёная стена ×", 0.1, 1.5, 0.01, 1))}
      ${environmentEditor(range, select)}
      ${group("Материал", select("material", "Тип", '<option value="diffuse">Диффузный</option><option value="dielectric">Диэлектрик</option><option value="textured">Текстурный</option>') + '<div id="dielectric-settings">' + select("dielectric-mode", "Модель поверхности", '<option value="auto">Авто</option><option value="volume">Объёмный</option><option value="thin">Тонкий</option>') + range("ior", "IOR при 587,6 нм", 1, 2.5, 0.0001, 1.7) + '<label class="check"><input id="dispersion" type="checkbox" disabled>Дисперсия (Cauchy)</label><div id="dispersion-settings">' + range("abbe", "Число Аббе", 10, 1000, 1, 64) + '</div><label class="field"><span>Цвет пропускания</span><input id="transmission-color" type="color" value="#bad6fe" disabled></label>' + range("transmission-depth", "Эталонная глубина, м", 0.0001, 1000, 0.0001, 0.1) + range("roughness", "Шероховатость", 0, 1, 0.01, 0) + surfaceWearEditor() + '</div><div id="diffuse-settings">' + range("albedo", "Диффузное альбедо", 0, 1, 0.01, 0.65) + '</div>' + `<div id="texture-group" hidden>${select("texture-kind", "Текстура", '<option value="marble">Мрамор</option><option value="lava">Лава</option>')}${range("texture-scale", "Частота рисунка", 1, 30, 0.1, 9) + range("texture-turbulence", "Искажение рисунка", 0, 4, 0.05, 2) + range("texture-width", "Ширина прожилок / лавы", 0.01, 0.4, 0.01, 0.1) + range("texture-coating", "Полировка / отражение", 0, 0.95, 0.01, 0.08)}<div id="lava-settings">${range("lava-power", "Свечение лавы", 0, 30, 0.1, 6)}${range("lava-temperature", "Цвет свечения, K", 1400, 3600, 50, 2000)}</div></div>`, true)}
      ${group("SPPM / Фотоны", '<label class="field"><span>Путей / итерацию</span><input id="photons" type="number" min="1" max="' + settingsLimits.maxPhotons + '" step="1024" value="16384" disabled></label>' + select("batch", "Путей / пакет", "<option>64</option><option>128</option><option>256</option><option>512</option><option selected>1024</option><option>2048</option><option>4096</option><option>8192</option><option>16384</option>") + range("radius", "Начальный радиус, м", 0.001, 0.2, 0.001, 0.03))}
      ${group("Отображение", range("exposure", "Экспозиция, EV", -8, 8, 0.1, 0) + select("tone-mapper", "Tone mapping", '<option value="reinhard">Reinhard</option><option value="aces">ACES fit</option><option value="linear">Linear / clamp</option>') + denoiseEditor(), true)}
      ${group("Память и экспорт", select("memory-profile", "GPU-профиль", '<option value="192">Integrated / 192 MiB</option><option value="384">Desktop / 384 MiB</option><option value="512">512 MiB</option><option value="1024">1 GiB</option><option value="2048">2 GiB</option><option value="4096">4 GiB</option><option value="custom">Вручную</option>') + range("memory-budget", "Бюджет, MiB", settingsLimits.minMemoryMiB, settingsLimits.maxMemoryMiB, 16, 192) + '<div class="export-buttons"><button id="export-png" disabled>PNG</button><button id="export-pfm" disabled>Raw PFM + JSON</button><button id="restart" disabled>Начать накопление заново</button></div><p id="export-status" role="status" class="hint"></p>')}
    </aside>
  </div>
  <footer class="statusbar"><strong id="status">Инициализация…</strong><p id="stats">Запрашиваем GPU-адаптер</p><span id="elapsed">00:00</span></footer>
</main>`;
}
