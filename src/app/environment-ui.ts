import { HdrImporter, hdrPresets } from '../assets/hdr-import';
import type { HdrImage } from '../assets/hdr';
import type { IntersectionRenderer } from '../render/intersection-renderer';
import { arrangeScene, type EnvironmentSettings } from '../scene/environment';
import type { SceneDescription } from '../scene/types';

export function environmentEditor(range: (id: string, label: string, min: number, max: number, step: number, value: number) => string, select: (id: string, label: string, options: string) => string): string {
  return `<details><summary>Окружение</summary><div class="group">${select('environment-source', 'Источник', '<option value="off">Выключено</option><option value="color">Цвет</option><option value="hdr">HDR</option>')}
    <div id="environment-settings" hidden><div id="hdr-settings" hidden>
    ${select('environment-map', 'HDR', '<option value="studio_small_09">Studio small 09</option><option value="kiara_1_dawn">Kiara 1 dawn</option><option value="venice_sunset">Venice sunset</option>')}
    <button id="import-hdr" disabled>Загрузить HDR</button><input id="hdr-file" type="file" accept=".hdr" hidden><p id="hdr-status" role="status" class="hint"></p>
    ${select('environment-quality', 'Качество HDR', '<option value="1024">1K</option><option value="2048" selected>2K</option><option value="4096">4K</option>')}</div>
    <label class="field"><span>Цвет / оттенок</span><input id="environment-color" type="color" value="#ffffff" disabled></label>
    ${range('environment-strength', 'Сила света', 0, 64, .1, 1)}${range('environment-rotation', 'Поворот Y, °', 0, 360, 1, 0)}
    <label class="check"><input id="environment-background" type="checkbox" checked disabled>Показывать фон</label>
    ${range('background-exposure', 'Экспозиция фона, EV', -8, 8, .1, 0)}${range('background-blur', 'Размытие фона', 0, 1, .01, 0)}
    </div></div></details>`;
}
export function arrangementEditor(): string {
  return '<label class="field"><span>Сцена</span><select id="scene-layout" disabled><option value="cornell">Cornell</option><option value="open">Открытая сцена</option></select></label><div id="ground-setting" hidden><label class="check"><input id="ground" type="checkbox" disabled>Пол</label></div><label class="check"><input id="area-light" type="checkbox" checked disabled>Потолочный свет</label>';
}

const ids = ['environment-source', 'environment-map', 'environment-quality', 'environment-color', 'environment-strength', 'environment-rotation', 'environment-background', 'background-exposure', 'background-blur'];
const control = (id: string) => document.getElementById(id) as HTMLInputElement;
export function environmentSettings(): EnvironmentSettings {
  const hex = control('environment-color').value;
  const linear = (n: number) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  return {
    source: control('environment-source').value as EnvironmentSettings['source'],
    color: [1, 3, 5].map(i => linear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number],
    strength: Number(control('environment-strength').value), rotation: Number(control('environment-rotation').value),
    background: control('environment-background').checked, exposure: Number(control('background-exposure').value), blur: Number(control('background-blur').value),
  };
}
export function applyArrangement(scene: SceneDescription): void {
  arrangeScene(scene, control('scene-layout').value === 'open', control('ground').checked, control('area-light').checked);
  scene.environment = environmentSettings();
}
export function setupEnvironment(renderer: IntersectionRenderer, queueScene: () => void, showError: (error: unknown) => void): { initialize(): Promise<void>; dispose(): void; metadata(): object } {
  const importer = new HdrImporter(); let localFile: File | undefined, image: HdrImage | undefined, key = '', revision = 0;
  let committedFile: File | undefined, committedKey = '';
  let committed = Object.fromEntries(ids.map(id => [id, control(id).type === 'checkbox' ? control(id).checked : control(id).value]));
  const status = document.getElementById('hdr-status')!;
  const update = async () => {
    const token = ++revision;
    const settings = environmentSettings(), name = control('environment-map').value, quality = Number(control('environment-quality').value);
    const nextKey = `${name}:${quality}:${name === 'uploaded' ? localFile?.name : ''}`;
    try {
      if (settings.source !== 'hdr') importer.dispose();
      let nextImage = image;
      if (settings.source === 'hdr' && key !== nextKey) {
        status.textContent = 'Загрузка HDR…';
        const source = name === 'uploaded' ? localFile : hdrPresets[name as keyof typeof hdrPresets];
        if (!source) throw new Error('Выберите или загрузите HDR.');
        nextImage = await importer.load(source, quality);
      }
      if (token !== revision) return;
      await renderer.setEnvironment(settings, nextImage);
      if (token !== revision) return;
      image = nextImage; if (settings.source === 'hdr') key = nextKey;
      committedFile = localFile; committedKey = key;
      committed = Object.fromEntries(ids.map(id => [id, control(id).type === 'checkbox' ? control(id).checked : control(id).value]));
      status.textContent = settings.source === 'hdr' && image ? `${name === 'uploaded' ? localFile!.name : (document.getElementById('environment-map') as HTMLSelectElement).selectedOptions[0]!.text} · ${image.width}×${image.height}` : '';
    } catch (error) {
      if (token !== revision || error instanceof DOMException && error.name === 'AbortError') return;
      localFile = committedFile; key = committedKey;
      for (const [id, value] of Object.entries(committed)) {
        if (typeof value === 'boolean') control(id).checked = value; else control(id).value = value;
        const number = document.getElementById(id + '-value') as HTMLInputElement | null; if (number) number.value = String(value);
      }
      status.textContent = 'HDR не применён. Предыдущее окружение сохранено.'; sync(); showError(error);
    }
  };
  const sync = () => {
    const hdr = control('environment-source').value === 'hdr';
    document.getElementById('hdr-settings')!.hidden = !hdr;
    document.getElementById('environment-settings')!.hidden = control('environment-source').value === 'off';
    const open = control('scene-layout').value === 'open';
    document.getElementById('ground-setting')!.hidden = !open;
    for (const id of ['object-x', 'object-y', 'object-z', 'object-scale']) {
      const min = open ? id === 'object-scale' ? .01 : -10 : id === 'object-y' ? .5 : id === 'object-scale' ? .25 : -.35;
      const max = open ? 10 : id === 'object-scale' ? 1.4 : id === 'object-y' ? 1.3 : .35;
      for (const suffix of ['', '-value']) { control(id + suffix).min = String(min); control(id + suffix).max = String(max); }
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  for (const id of ids) control(id).addEventListener(control(id).type === 'range' || control(id).type === 'color' ? 'input' : 'change', () => {
    sync(); clearTimeout(timer); timer = setTimeout(() => void update(), 50);
  });
  let opened = control('scene-layout').value === 'open';
  control('scene-layout').addEventListener('change', () => {
    const open = control('scene-layout').value === 'open'; control('area-light').checked = !open;
    if (open && !opened) { opened = true; control('environment-source').value = 'hdr'; control('environment-map').value = 'studio_small_09'; void update(); }
    sync(); queueScene();
  });
  for (const id of ['ground', 'area-light']) control(id).addEventListener('change', queueScene);
  document.getElementById('import-hdr')!.addEventListener('click', () => control('hdr-file').click());
  control('hdr-file').addEventListener('change', () => {
    const file = control('hdr-file').files?.[0]; control('hdr-file').value = ''; if (!file) return;
    localFile = file; key = '';
    const select = document.getElementById('environment-map') as HTMLSelectElement;
    if (!select.querySelector('option[value="uploaded"]')) select.add(new Option('Свой HDR', 'uploaded'));
    select.value = 'uploaded'; control('environment-source').value = 'hdr'; sync(); void update();
  });
  sync();
  return { initialize: update, dispose: () => { clearTimeout(timer); importer.dispose(); }, metadata: () => ({ ...environmentSettings(), map: control('environment-map').value, quality: Number(control('environment-quality').value), file: control('environment-map').value === 'uploaded' ? localFile?.name : undefined, layout: control('scene-layout').value, ground: control('ground').checked, areaLight: control('area-light').checked, spectrum: 'PBRT RGB illuminant approximation' }) };
}
