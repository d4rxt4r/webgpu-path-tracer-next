import { setupDiffuseEditor, diffuseControlIds } from "./diffuse-editor";
import { setupOpaqueEditor, opaqueControlIds } from "./opaque-editor";
import { bindNumericControls, numericLimits, readControl, writeControl } from "./numeric-controls";
import { cameraOptics, distanceFraction, logDistance } from "../scene/camera";
import { cleanSurface, rastagotchiWear, wearControlIds, wearEffects } from "../scene/surface-wear";
import { applyArrangement, setupEnvironment } from './environment-ui';
import { applyMaterialEditor, baseMaterial, initializeMaterialEditor, materialControlIds, materialMetadata, syncMaterialEditor, textureMemory } from "./material-editor";
import { builtinModels, isBuiltinModel, loadBuiltinObj, type BuiltinObj } from "../assets/builtin-obj";
import type { RepairedObj } from "../assets/mesh-repair";
import { ObjImporter } from "../assets/obj-import";
import type { ImportedObj } from "../assets/obj";
import { attachSettingsHelp } from "./settings-help";
import { attachMiddleReset } from "./settings-reset";
import { createSettingsLink, restoreSettingsLink } from "./settings-link";
import "./style.css";
import { renderEditor, pauseButtonContent } from "./editor-ui";
import { createDevice } from "../gpu/device";
import { cornellScene } from "../scene/cornell";
import type { SphereMaterial } from "../scene/cornell";
import { presentationScene } from "../scene/presentation";
import { buddhaScene } from "../scene/buddha";
import { attachOrbit } from "./orbit";
import { profiles, qualityProfile } from "./profiles";
import type { Profile } from "./profiles";
import type { PathSettings, DebugView } from "../render/intersection-renderer";
import { download, encodePfm } from "./export";
import {
  applySceneControls,
  sceneControlIds,
  applyTextureControls,
  textureControlIds,
} from "../scene/editor";
import type { SceneControls, TextureControls } from "../scene/editor";

const query = new URLSearchParams(location.search);
const pathControls: Record<string, keyof PathSettings> = {
  mode: "mode", integrator: "integrator", resolution: "maxPixels", strategy: "strategy",
  "max-depth": "maxDepth", seed: "seed", photons: "photonsPerIteration", batch: "photonBatchSize",
  radius: "initialRadius", "memory-budget": "memoryBudgetMiB",
};
const initialScene =
  query.get("scene") === "control"
    ? "control"
    : query.get("scene") === "buddha"
      ? "buddha"
      : query.get("scene") === "rastagotchi" ? "rastagotchi" : query.get("scene") === "suzanne" ? "suzanne" : "suzanne-high-poly";
const controlScene = initialScene === "control";
const requestedMaterial = query.get("material");
const initialMaterial: SphereMaterial =
  requestedMaterial && ["diffuse", "glass", "blue-glass", "nbk7", "nbk7-constant", "marble", "lava"].includes(requestedMaterial)
    ? requestedMaterial as SphereMaterial
    : controlScene
      ? "diffuse"
      : initialScene === "buddha"
        ? "marble"
        : initialScene === "rastagotchi" ? "glass" : "blue-glass";
document.querySelector<HTMLDivElement>("#app")!.innerHTML =
  renderEditor(controlScene);
attachSettingsHelp();

const input = (id: string): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`#${id}`)!;
const selectInput = (id: string): HTMLSelectElement =>
  document.querySelector<HTMLSelectElement>(`#${id}`)!;
const button = (id: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`#${id}`)!;
const value = (id: string): number => Number(readControl(document, id));
const canvas = document.querySelector("canvas")!;
const status = document.querySelector<HTMLElement>("#status")!;
const stats = document.querySelector<HTMLElement>("#stats")!;
const activity = document.querySelector<HTMLElement>("#activity")!;
const exportStatus = document.querySelector<HTMLElement>("#export-status")!;
const errorPanel = document.querySelector<HTMLElement>("#error")!;
const errorMessage = document.querySelector<HTMLElement>("#error-message")!;
button("error-dismiss").addEventListener("click", () => {
  errorPanel.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !errorPanel.hidden) {
    errorPanel.hidden = true;
    event.preventDefault();
  }
});
bindNumericControls(document, error => { errorPanel.hidden = false; errorMessage.textContent = error.message; });
const description = cornellScene(initialMaterial);
if (initialScene === "buddha") {
  input("object-y").value = "0.86";
  description.camera.target = [0, 0.9, 0];
  description.camera.position = [0, 0.9, 3.7];
}
if (!controlScene) {
  input("ior").value = input("ior-value").value = "1.7";
}
selectInput("scene").value = initialScene;
initializeMaterialEditor(initialMaterial);
if (initialScene === "rastagotchi" && !requestedMaterial) applyRastagotchiPreset();
function applyWearPreset(rastagotchi: boolean): void {
  const wear = rastagotchi ? rastagotchiWear : cleanSurface;
  for (const name of wearEffects) for (const [key, value] of Object.entries(wear[name])) {
    const control = document.getElementById(`wear-${name}-${key}`) as HTMLInputElement | null;
    if (!control) continue;
    if (typeof value === "boolean") control.checked = value; else control.value = String(value);
    const number = document.getElementById(`${control.id}-value`) as HTMLInputElement | null;
    if (number) number.value = String(value);
  }
}
function applyRastagotchiPreset(): void {
  applyWearPreset(true);
  initializeMaterialEditor("glass");
  selectInput("dielectric-mode").value = "auto";
  input("transmission-color").value = "#f4fff6";
  for (const [id, value] of [["ior", "1.5"], ["roughness", "0.03"], ["transmission-depth", "0.1"]] as const) {
    input(id).value = value;
    const number = document.getElementById(`${id}-value`) as HTMLInputElement | null;
    if (number) number.value = value;
  }
}
if (initialMaterial === "lava") {
  input("texture-scale").value = "6";
  writeControl(document, "texture-width", "0.04");
}
function currentModelIsSolid(): boolean {
  const selected = selectInput("scene").value;
  if (selected === "uploaded") return uploadedObj?.solid ?? false;
  if (isBuiltinModel(selected)) return currentBuiltinModel?.solid ?? true;
  return true;
}
function syncObjectScale(): void {
  const max = selectInput("scene-layout").value === "open" ? 10 : selectInput("scene").value === "buddha" ? 1.15 : 1.4;
  input("object-scale").max = input("object-scale-value").max = String(max);
  input("object-scale").value = String(Math.min(max, value("object-scale")));
}
syncObjectScale();
const objImporter = new ObjImporter();
let uploadedObj: (ImportedObj & { name: string; original: ImportedObj; repaired?: RepairedObj }) | undefined;
let committedObj: typeof uploadedObj;
let currentBuiltinModel: BuiltinObj | undefined;
let target: PathSettings = {
  maxDepth: controlScene ? 8 : 32,
  seed: 1,
  strategy: "mis",
  maxPixels: controlScene ? 76800 : 307200,
  mode: controlScene ? "rgb" : "spectral",
  integrator: controlScene ? "pt" : "sppm",
  photonsPerIteration: 16384,
  photonBatchSize: 1024,
  initialRadius: 0.03,
  memoryBudgetMiB: 192,
};
let userPaused = false,
  interacting = false,
  ready = false,
  lastSamples = 0,
  scenePending = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined,
  sceneTimer: ReturnType<typeof setTimeout> | undefined;
let profile: Profile = controlScene ? "custom" : "quality";

function syncRanges(): void {
  for (const slider of document.querySelectorAll<HTMLInputElement>("[data-log-for]")) { const field = input(slider.dataset.logFor!); slider.value = String(1000 * distanceFraction(Number(field.value), Number(field.min), Number(field.max))); }
  for (const slider of document.querySelectorAll<HTMLInputElement>(
    "input[type=range]:not([data-log-for])",
  ))
    if (numericLimits[slider.id]) writeControl(document, slider.id, readControl(document, slider.id)); else input(`${slider.id}-value`).value = slider.value;
}
let refreshOpticsUi: (() => void) | undefined;
function syncSettings(): void {
  selectInput("profile").value = profile;
  selectInput("mode").value = target.mode;
  selectInput("integrator").value = target.integrator;
  selectInput("resolution").value = String(target.maxPixels);
  selectInput("strategy").value = target.strategy;
  input("max-depth").value = String(target.maxDepth);
  input("seed").value = String(target.seed);
  input("photons").value = String(target.photonsPerIteration);
  selectInput("batch").value = String(target.photonBatchSize);
  writeControl(document, "radius", String(target.initialRadius));
  writeControl(document, "memory-budget", String(target.memoryBudgetMiB));
  const memoryProfile = selectInput("memory-profile");
  memoryProfile.value = Array.from(memoryProfile.options).some(option => option.value === String(target.memoryBudgetMiB)) ? String(target.memoryBudgetMiB) : "custom";
  if (ready) {
    if (
      target.integrator !== "sppm" &&
      selectInput("view").value === "photon-density"
    )
      selectInput("view").value = "beauty";
    selectInput("view").querySelector<HTMLOptionElement>(
      "[value=photon-density]",
    )!.disabled = target.integrator !== "sppm";
    selectInput("strategy").disabled = target.integrator === "sppm";
    input("photons").disabled =
      selectInput("batch").disabled =
      input("radius").disabled =
      input("radius-value").disabled =
        target.integrator !== "sppm";
    input("repair-obj").disabled = !(selectInput("scene").value === "uploaded" || isBuiltinModel(selectInput("scene").value));
    syncMaterialEditor(currentModelIsSolid());
    for (const id of ["denoise-passes", "denoise-strength", "denoise-blend", "denoise-radius", "glass-strength", "denoise-normal", "denoise-depth", "denoise-split"])
      input(id).disabled = input(`${id}-value`).disabled = !input("denoiser").checked;
    for (const id of ["denoise-algorithm", "glass-mode"]) selectInput(id).disabled = !input("denoiser").checked;
    input("denoise-compare").disabled = !input("denoiser").checked;
    const algorithm = selectInput("denoise-algorithm").value;
    input("denoise-passes").closest<HTMLElement>(".setting-row")!.hidden = algorithm !== "atrous";
    input("denoise-radius").closest<HTMLElement>(".setting-row")!.hidden = algorithm === "atrous";
    input("glass-strength").closest<HTMLElement>(".setting-row")!.hidden = selectInput("glass-mode").value === "off";
    input("denoise-split").closest<HTMLElement>(".setting-row")!.hidden = !input("denoise-compare").checked;
    button("apply-nlm").hidden = algorithm !== "nlm";
    button("apply-nlm").disabled = !input("denoiser").checked || lastSamples === 0 || scenePending;
    document.querySelector("#denoise-status")!.textContent = algorithm === "nlm" ? "NLM применяется на паузе или после достижения цели. При накоплении показан оригинал." : "";
    button("export-png").disabled = button("export-pfm").disabled =
      lastSamples === 0 ||
      selectInput("view").value !== "beauty" ||
      interacting ||
      scenePending;
  }
  syncRanges();
  refreshOpticsUi?.();
}
syncSettings();
if (query.get('settings') === '1' && query.get('scene-layout') === 'open') {
  for (const id of ['object-x', 'object-y', 'object-z', 'object-scale']) for (const suffix of ['', '-value']) {
    input(id + suffix).min = id === 'object-scale' ? '.01' : '-10';
    input(id + suffix).max = '10';
  }
}
const originalCamera = structuredClone(description.camera);
const linkedCamera = restoreSettingsLink(document, query, description.camera);
setupOpaqueEditor();
setupDiffuseEditor();
const hasSharedSettings = linkedCamera !== undefined;
if (linkedCamera) {
  description.camera = linkedCamera;
  input("camera-distance").value = String(Math.hypot(...linkedCamera.position.map((v, i) => v - linkedCamera.target[i]!)));
  for (const [id, key] of Object.entries(pathControls)) {
    const raw = readControl(document, id);
    target = { ...target, [key]: key === "mode" || key === "integrator" || key === "strategy" ? raw : Number(raw) };
  }
  profile = selectInput("profile").value as Profile;
  if (target.integrator !== "sppm" && selectInput("view").value === "photon-density") selectInput("view").value = "beauty";
  syncObjectScale();
  syncMaterialEditor(true, false);
  syncSettings();
}

async function start(): Promise<void> {
  if (!isSecureContext || !navigator.gpu) await createDevice();
  const { IntersectionRenderer } = await import(
    "../render/intersection-renderer"
  );
  const startupAt = performance.now();
  const startupTimings: Record<string, number> = {};
  const startupTasks = new Set<string>();
  const updateStartupStatus = (): void => {
    if (ready) return;
    const stages: Record<string, string> = {
      model: "Загрузка модели…", scene: "Подготовка сцены…",
      environment: "Загрузка окружения…", gpu: "Подготовка Preview…",
    };
    const stage = Object.keys(stages).find(name => startupTasks.has(name));
    if (stage) status.textContent = stages[stage]!;
  };
  const startupPreview = ["beauty", "photon-density"].includes(selectInput("view").value) && (!controlScene || target.integrator === "sppm");
  let startupPending = startupPreview, promotionStarted = false, targetPending = false, targetRequest = 0;
  const timeStartup = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    startupTasks.add(name);
    updateStartupStatus();
    try { return await work(); }
    finally {
      startupTimings[name] = performance.now() - start;
      startupTasks.delete(name);
      updateStartupStatus();
    }
  };
  let accumulationStart = performance.now(),
    previousRevision = -1;
  const renderer = new IntersectionRenderer(
    canvas,
    (info) => {
      status.textContent = {
        ready: "WebGPU готов",
        paused: "Пауза",
        recovering: "Восстановление GPU…",
        initializing: "Подготовка GPU…",
        error: "Ошибка GPU",
      }[info.status];
      if (info.status === "initializing") updateStartupStatus();
      const phase = (
        {
          camera: "камера",
          photon: "фотоны",
          gather: "сбор света",
          update: "обновление",
        } as Record<string, string>
      )[info.phase];
      const progress =
        info.integrator === "sppm"
          ? `${info.samples} итераций · ${info.emittedPhotons.toLocaleString("ru")} фотонов`
          : `${info.samples} spp`;
      stats.textContent = `${info.adapter} · ${info.width} × ${info.height} · ${info.triangles} треугольников · ${(info.bytes / 1048576).toFixed(2)} MiB · ${progress} · ${info.tile}/${info.tiles} tiles · завершение ${info.completionMs.toFixed(1)} мс`;
      stats.textContent +=
        info.gpuMs === undefined
          ? " · GPU timestamp: недоступен"
          : ` · GPU ${info.gpuMs.toFixed(2)} мс`;
      stats.title = stats.textContent;
      activity.textContent = targetPending ? "Preview / подготовка выбранного режима…" : interacting
        ? "Preview / движение камеры"
        : `${profile === "custom" ? "Вручную" : profile} · ${info.integrator.toUpperCase()} / ${info.phase === "camera" ? "накопление" : phase}`;
      if (info.revision !== previousRevision)
        accumulationStart = performance.now();
      previousRevision = info.revision;
      const elapsed = Math.floor(
        (performance.now() - accumulationStart) / 1000,
      );
      document.querySelector<HTMLElement>("#elapsed")!.textContent =
        `${Math.floor(elapsed / 60)
          .toString()
          .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;
      canvas.dataset.frames = String(info.frames);
      canvas.dataset.samples = String(info.samples);
      canvas.dataset.tile = String(info.tile);
      canvas.dataset.revision = String(info.revision);
      canvas.dataset.presentedRevision = String(info.presentedRevision);
      canvas.dataset.phase = info.phase;
      canvas.dataset.integrator = info.integrator;
      canvas.dataset.interacting = String(interacting);
      lastSamples = info.samples;
      if (ready) button("apply-nlm").disabled = !input("denoiser").checked || lastSamples === 0 || scenePending || targetPending || startupPending;
      if (ready && startupPending && !promotionStarted && info.samples > 0 && info.presentedRevision === info.revision) {
        promotionStarted = true;
        startupTimings["first-preview"] = performance.now() - startupAt;
        applyTarget();
      }
      if (!startupPending && info.samples > 0 && info.presentedRevision === info.revision && startupTimings["first-target"] === undefined)
        startupTimings["first-target"] = performance.now() - startupAt;
      canvas.dataset.startupTimings = JSON.stringify({...startupTimings, ...renderer.startupTimings});
      const goal = value("sample-limit");
      if (
        ready && !startupPending && !targetPending &&
        goal > 0 &&
        info.samples >= goal &&
        info.status === "ready" &&
        !interacting &&
        !userPaused
      ) {
        userPaused = true;
        button("pause").innerHTML = pauseButtonContent(userPaused);
        renderer.pause();
      }
      button("restart").disabled = button("pause").disabled =
        !ready || info.status === "error" || info.status === "recovering";
      if (ready)
        button("export-png").disabled = button("export-pfm").disabled =
          startupPending || targetPending || lastSamples === 0 ||
          selectInput("view").value !== "beauty" ||
          interacting ||
          scenePending;
    },
    showError,
  );
  function showError(error: unknown): void {
    if (error instanceof DOMException && error.name === "AbortError") return;
    errorPanel.hidden = false;
    errorMessage.textContent =
      error instanceof Error ? error.message : String(error);
  }
  let currentCamera = description.camera,
    sceneRevision = 0;
  const applyTarget = (): void => {
    const next = renderer.validateSettings(target);
    const request = ++targetRequest;
    targetPending = true;
    clearTimeout(idleTimer);
    void renderer.prepareIntegrator(next.integrator, next.mode).then(() => {
      if (request !== targetRequest) return;
      renderer.setSettings(next);
      if (startupPending) renderer.setDebugView(selectInput("view").value as DebugView);
      startupPending = targetPending = false;
      interacting = false;
      renderer.setInteracting(false);
      syncSettings();
    }).catch(error => {
      if (request !== targetRequest) return;
      targetPending = false;
      showError(error);
    });
    syncSettings();
  };
  const denoiseControls = () => ({
    algorithm: selectInput("denoise-algorithm").value as "atrous" | "bilateral" | "nlm",
    glassMode: selectInput("glass-mode").value as "off" | "surface" | "image",
    filterGlass: selectInput("glass-mode").value !== "off",
    glassStrength: value("glass-strength"), blend: value("denoise-blend") / 100,
    normalPower: value("denoise-normal"), depthScale: value("denoise-depth"),
    radius: value("denoise-radius"), compare: input("denoise-compare").checked, split: value("denoise-split") / 100,
  });
  const applyDisplay = (): void => {
    renderer.setDisplay({
      enabled: input("denoiser").checked,
      passes: value("denoise-passes"),
      strength: value("denoise-strength"),
      ...denoiseControls(),
      toneMapper: selectInput("tone-mapper").value as
        | "reinhard"
        | "aces"
        | "linear",
    });
    syncSettings();
    syncOptics();
  };
  const settle = (): void => {
    clearTimeout(idleTimer);
    applyTarget();
  };
  const orbit = attachOrbit(canvas, description.camera, (camera) => {
    try { renderer.setCamera(camera); } catch (error) {
      writeControl(document, "fov", String(currentCamera.verticalFov));
      input('camera-distance').value = String(Number(Math.hypot(...currentCamera.position.map((v,i)=>v-currentCamera.target[i]!)).toPrecision(12)));
      syncOptics();
      const status = document.querySelector<HTMLElement>('#camera-status')!;
      status.hidden = false;
      status.textContent = String(error);
      return false;
    }
    currentCamera = camera;
    document.querySelector<HTMLElement>('#camera-status')!.hidden = true;
    syncOptics();
    writeControl(document, "fov", String(camera.verticalFov));
    input("camera-distance").value = String(
      Number(Math.hypot(...camera.position.map((v, i) => v - camera.target[i]!)).toPrecision(12)),
    );
    syncRanges();
    if (
      input("auto-preview").checked &&
      selectInput("view").value === "beauty"
    ) {
      clearTimeout(idleTimer);
      targetRequest++;
      targetPending = false;
      interacting = true;
      renderer.setInteracting(true);
      renderer.setSettings({ ...target, ...profiles.preview });
      idleTimer = setTimeout(settle, 250);
    }
  });
  let pickingFocus = false;
  const focusStatus = document.querySelector<HTMLElement>('#focus-status')!;
  function syncOptics(): void {
    const d = currentCamera.depthOfField ?? {}, optics = cameraOptics(currentCamera);
    input('dof-enabled').checked = !!d.enabled;
    input('aperture-diameter').value = String((d.apertureDiameter ?? .02) * 1000);
    input('focus-distance').value = String(d.focusDistance ?? Math.hypot(...currentCamera.position.map((v,i)=>v-currentCamera.target[i]!)));
    input('focus-distance').dataset.default = String(Math.hypot(...originalCamera.position.map((v,i)=>v-originalCamera.target[i]!)));
    selectInput('focus-mode').value = d.focusMode ?? 'target'; selectInput('aperture-shape').value = d.apertureShape ?? 'circle';
    input('aperture-blades').value = String(d.blades ?? 6); input('aperture-rotation').value = String(d.rotation ?? 0);
    document.querySelector<HTMLElement>('#dof-settings')!.hidden = !d.enabled;
    document.querySelector<HTMLElement>('#manual-focus')!.hidden = d.focusMode !== 'manual';
    document.querySelector<HTMLElement>('#polygon-settings')!.hidden = d.apertureShape !== 'polygon';
    focusStatus.textContent = pickingFocus ? 'Нажмите на поверхность; Escape — отмена.' : `Фокус: ${optics.distance.toFixed(3)} м${optics.behind ? ' — точка позади камеры, применена минимальная дистанция.' : ''}`;
    for (const id of ['denoise-normal','denoise-depth','glass-strength']) for (const suffix of ['', '-value']) input(id+suffix).disabled = optics.active || !input('denoiser').checked;
    selectInput('glass-mode').disabled = optics.active || !input('denoiser').checked;
    document.querySelector('#denoise-status')!.textContent = optics.active
      ? 'При глубине резкости фильтруется весь кадр по изображению; защита геометрии и отдельные режимы стекла недоступны.'
      : selectInput('denoise-algorithm').value === 'nlm' ? 'NLM применяется на паузе или после достижения цели. При накоплении показан оригинал.' : '';
    syncRanges();
  }
  function changeOptics(event: Event): void {
    // Logarithmic number fields commit on change; let users finish typing.
    if (event.isTrusted && event.type === 'input' && (event.target as HTMLInputElement).id === 'focus-distance') return;
    const d = { ...currentCamera.depthOfField, enabled: input('dof-enabled').checked, apertureDiameter: value('aperture-diameter') / 1000,
      focusMode: selectInput('focus-mode').value as 'target' | 'manual' | 'point', focusDistance: value('focus-distance'),
      apertureShape: selectInput('aperture-shape').value as 'circle' | 'polygon', blades: value('aperture-blades'), rotation: value('aperture-rotation') };
    try { orbit.set({ ...currentCamera, depthOfField: d }); } catch (error) { syncOptics(); focusStatus.textContent = String(error); }
  }
  for (const id of ['dof-enabled','focus-mode','aperture-shape']) input(id).addEventListener('change', changeOptics);
  for (const id of ['aperture-diameter','focus-distance','aperture-blades','aperture-rotation']) input(id).addEventListener('input', changeOptics);
  button('pick-focus').addEventListener('click', () => { pickingFocus = true; canvas.style.cursor='crosshair'; syncOptics(); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && pickingFocus) { pickingFocus=false; canvas.style.cursor=''; syncOptics(); } });
  canvas.addEventListener('pointerdown', event => {
    if (!pickingFocus || event.button !== 0) return;
    event.stopImmediatePropagation(); event.preventDefault();
    const rect=canvas.getBoundingClientRect(), point=renderer.pickFocus((event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height);
    pickingFocus=false; canvas.style.cursor='';
    if (point) { try { orbit.set({...currentCamera, depthOfField:{...currentCamera.depthOfField,focusMode:'point',focusPoint:point}}); } catch (error) { focusStatus.textContent=String(error); } }
    else { syncOptics(); focusStatus.textContent += ' Промах: прежний фокус сохранён.'; }
  }, {capture:true});
  refreshOpticsUi = syncOptics;
  syncOptics();
  const objStatus = document.querySelector<HTMLElement>("#obj-status")!;
  const describeModel = (model: BuiltinObj, name: string, glass: boolean, thin = !model.solid): string => {
    let text = `${name} · ${model.triangles.toLocaleString("ru-RU")} треугольников · Оболочек: ${model.shells ?? 1}`;
    if (model.skippedDegenerateTriangles) text += ` · Пропущено граней нулевой площади: ${model.skippedDegenerateTriangles}`;
    if (glass) text += !thin ? " · Объёмное стекло" : " · Тонкое стекло: без объёмного преломления и поглощения";
    if (input("repair-obj").checked && model.repair) text += model.repair.success ? ` · Закрыто отверстий: ${model.repair.closedHoles}` : ` · Ремонт не выполнен: ${model.repair.reason}`;
    if (input("repair-obj").checked && model.repair?.success) {
      if (model.repair.removedFaces) text += ` · Удалено дефектных граней: ${model.repair.removedFaces}`;
      if (model.repair.collapsedEdges) text += ` · Исправлено сжатых рёбер: ${model.repair.collapsedEdges}`;
    }
    return text;
  };
  const textures = textureMemory();
  let committedTextures = textures.capture();
  const sceneFields = ["scene-layout", "ground", "area-light", "scene", "material", ...sceneControlIds.filter(id => id !== "absorption"), ...textureControlIds, ...materialControlIds];
  const captureSceneUi = () => Object.fromEntries(sceneFields.map(id => { const control = document.getElementById(id) as HTMLInputElement; return [id, control.type === "checkbox" ? control.checked : readControl(document, id)]; }));
  let committedUi = captureSceneUi();
  let committedRepair = input("repair-obj").checked;
  const restoreSceneUi = () => {
    uploadedObj = committedObj;
    textures.restore(committedTextures);
    input("repair-obj").checked = committedRepair;
    const option = selectInput("scene").querySelector<HTMLOptionElement>('[value="uploaded"]');
    if (uploadedObj && option) option.textContent = uploadedObj.name;
    else option?.remove();
    for (const [id, value] of Object.entries(committedUi)) { const control = document.getElementById(id) as HTMLInputElement; if (typeof value === "boolean") control.checked = value; else writeControl(document, id, value); }
    scenePending = false;
    syncObjectScale(); syncSettings();
  };
  const resetObject = () => {
    for (const id of ["object-scale", "object-x", "object-z", "object-rotation", "object-rotation-x", "object-rotation-z"]) input(id).value = id === "object-scale" ? "1" : "0";
    input("object-y").value = selectInput("scene").value === "buddha" ? "0.86" : selectInput("scene").value === "control" ? "0.65" : "1";
    syncObjectScale(); syncSettings();
  };
  const updateScene = async (revision: number): Promise<void> => {
    activity.textContent = "Подготовка сцены…";
    const material = baseMaterial();
    const selected = selectInput("scene").value;
    try {
      const builtin = isBuiltinModel(selected) ? await loadBuiltinObj(selected, input("repair-obj").checked) : undefined;
      const scene = selected === "buddha" ? await buddhaScene(material, builtin)
        : builtin ? await presentationScene(material, builtin) : cornellScene(material);
      if (revision !== sceneRevision) return;
      if (selected === "uploaded") {
        if (!uploadedObj) throw new Error("Загруженная модель отсутствует.");
        const original = uploadedObj.original;
        if (input("repair-obj").checked) {
          let repaired = uploadedObj.repaired;
          if (!repaired) {
            objStatus.textContent = "Закрытие отверстий…";
            repaired = await objImporter.repair(original);
            if (revision !== sceneRevision) return;
          }
          uploadedObj = { ...uploadedObj, ...repaired, repaired };
        } else uploadedObj = { ...uploadedObj, ...original };
        scene.meshes[6] = uploadedObj.mesh;
        scene.objects[3]!.material = 2; scene.objects[4]!.material = 1;
        const surface = scene.materials[4]!;
        if (surface.type === "dielectric") surface.thin = !uploadedObj.solid;
      }
      const controls = Object.fromEntries(sceneControlIds.map(id => [id, id === "absorption" ? 1 : value(id)])) as SceneControls;
      applySceneControls(scene, controls, selectInput("scene-layout").value !== "open");
      applyArrangement(scene);
      applyTextureControls(scene, Object.fromEntries(textureControlIds.map(id => [id, value(id)])) as TextureControls);
      applyMaterialEditor(scene, selected === "uploaded" ? uploadedObj!.solid : builtin?.solid ?? true);
      scene.camera = currentCamera;
      await renderer.setScene(scene);
      if (revision !== sceneRevision) return;
      for (const id of ["object-x", "object-y", "object-z"] as const) input(id).value = String(controls[id]);
      scenePending = false;
      if (builtin) currentBuiltinModel = builtin;
      committedObj = uploadedObj;
      committedRepair = input("repair-obj").checked;
      committedUi = captureSceneUi();
      committedTextures = textures.capture();
      errorPanel.hidden = true;
      const name = selected === "uploaded" ? uploadedObj!.name : selected === "rastagotchi" ? "Rastagotchi" : selected === "suzanne-high-poly" ? "Suzanne high poly" : selected === "suzanne" ? "Suzanne" : selected === "buddha" ? "Happy Buddha" : "Sphere";
      const model = selected === "uploaded" ? { ...uploadedObj!, repair: uploadedObj!.repaired?.repair } : builtin;
      const glass = scene.materials[4]!.type === "dielectric";
      const thin = scene.materials[4]!.type === "dielectric" && !!scene.materials[4]!.thin;
      objStatus.textContent = model ? describeModel(model, name, glass, thin) : "";
      document.querySelector<HTMLElement>("#scene-name")!.textContent = `${name} / ${selectInput("material").selectedOptions[0]!.textContent}${thin ? " / тонкое стекло" : ""}`;
      syncSettings();
    } catch (error) {
      if (revision === sceneRevision) { restoreSceneUi(); objStatus.textContent = "Изменение не применено; предыдущий объект сохранён."; showError(error); }
    }
  };
  const queueScene = (): void => {
    objImporter.cancel();
    renderer.cancelScenePreparation();
    scenePending = true;
    button("export-png").disabled = button("export-pfm").disabled = true;
    clearTimeout(sceneTimer);
    const revision = ++sceneRevision;
    sceneTimer = setTimeout(
      () => void updateScene(revision).catch(showError),
      80,
    );
  };
  const environmentUi = setupEnvironment(renderer, queueScene, showError);
  input("repair-obj").addEventListener("change", queueScene);
  input("metal-preset").addEventListener("change",()=>{syncMaterialEditor(currentModelIsSolid());queueScene();});
  button("import-obj").addEventListener("click", () => input("obj-file").click());
  input("obj-file").addEventListener("change", async () => {
    const file = input("obj-file").files?.[0]; input("obj-file").value = "";
    if (!file) return;
    clearTimeout(sceneTimer);
    const revision = ++sceneRevision;
    scenePending = true;
    renderer.cancelScenePreparation();
    button("export-png").disabled = button("export-pfm").disabled = true;
    objStatus.textContent = `Чтение ${file.name}…`;
    try {
      const result = await objImporter.load(file);
      if (revision !== sceneRevision) return;
      uploadedObj = { ...result, name: file.name, original: result };
      input("repair-obj").checked = true;
      let option = selectInput("scene").querySelector<HTMLOptionElement>('[value="uploaded"]');
      if (!option) { option = document.createElement("option"); option.value = "uploaded"; selectInput("scene").append(option); }
      option.textContent = file.name;
      selectInput("scene").value = "uploaded";
      applyWearPreset(false);
      resetObject();
      objStatus.textContent = `Подготовка ${file.name}…`;
      await updateScene(revision);
    } catch (error) {
      if (revision === sceneRevision) { restoreSceneUi(); objStatus.textContent = "Импорт не выполнен; предыдущий объект сохранён."; showError(error); }
    }
  });
  selectInput("scene").addEventListener("change", () => { resetObject(); applyWearPreset(selectInput("scene").value === "rastagotchi"); if (selectInput("scene").value === "rastagotchi") applyRastagotchiPreset(); syncSettings(); queueScene(); });
  selectInput("material").addEventListener("change", () => { syncSettings(); queueScene(); });
  selectInput("texture-kind").addEventListener("change", () => { textures.switch(); syncSettings(); queueScene(); });
  selectInput("dielectric-mode").addEventListener("change", () => { syncSettings(); queueScene(); });
  input("dispersion").addEventListener("change", () => { syncSettings(); queueScene(); });
  selectInput("profile").addEventListener("change", () => {
    const previous = target, previousProfile = profile, previousDenoiser = input("denoiser").checked;
    profile = selectInput("profile").value as Profile;
    try {
      if (profile !== "custom") {
        target = { ...target, ...profiles[profile] };
        input("denoiser").checked = qualityProfile(profile);
      }
      applyTarget();
      applyDisplay();
    } catch (error) {
      target = previous;
      profile = previousProfile;
      input("denoiser").checked = previousDenoiser;
      syncSettings();
      showError(error);
    }
  });
  for (const [id, key] of Object.entries(pathControls))
    document
      .querySelector(`#${id}`)!
      .addEventListener(
        id === "max-depth" || id === "radius" || id === "memory-budget"
          ? "input"
          : "change",
        () => {
          const control = document.querySelector<
            HTMLInputElement | HTMLSelectElement
          >(`#${id}`)!;
          const next =
            key === "mode" || key === "integrator" || key === "strategy"
              ? control.value
              : value(id);
          const previous = target, previousProfile = profile;
          target = { ...target, [key]: next };
          profile = "custom";
          try {
            applyTarget();
          } catch (error) {
            target = previous;
            profile = previousProfile;
            syncSettings();
            showError(error);
          }
        },
      );
  selectInput("memory-profile").addEventListener("change", () => {
    const selected = selectInput("memory-profile").value;
    if (selected === "custom") return;
    writeControl(document, "memory-budget", selected);
    input("memory-budget").dispatchEvent(new Event("input"));
  });
  input("auto-preview").addEventListener("change", () => {
    if (!input("auto-preview").checked) settle();
  });
  for (const id of [
    "object-scale",
    "object-x",
    "object-y",
    "object-z",
    "object-rotation",
    "object-rotation-x",
    "object-rotation-z",
    "light-power",
    "light-size",
    "light-x",
    "light-z",
    "wall-neutral",
    "wall-red",
    "wall-green",
    "ior",
    "abbe",
    "transmission-depth",
    "transmission-color",
    "roughness",
    "albedo",
    ...textureControlIds,
    ...diffuseControlIds,
    ...opaqueControlIds.filter(id=>id!=="metal-preset" && id!=="metal-custom-set" && id!=="metal-color-default"),
    ...wearControlIds,
  ])
    input(id).addEventListener("input", queueScene);
  for (const id of ["fov", "camera-distance"])
    input(id).addEventListener("input", (event) => {
      if (id === 'camera-distance' && event.isTrusted) return;
      const distance = value("camera-distance"),
        delta = currentCamera.position.map(
          (v, i) => v - currentCamera.target[i]!,
        ),
        radius = Math.hypot(...delta);
      orbit.set({
        ...currentCamera,
        verticalFov: value("fov"),
        position: currentCamera.target.map(
          (v, i) => v + (delta[i]! * distance) / radius,
        ) as [number, number, number],
      });
    });
  input("exposure").addEventListener("input", () =>
    renderer.setExposure(value("exposure")),
  );
  for (const id of ["denoiser", "denoise-compare"])
    input(id).addEventListener("change", applyDisplay);
  for (const id of ["denoise-passes", "denoise-strength", "denoise-blend", "denoise-radius", "glass-strength", "denoise-normal", "denoise-depth", "denoise-split"])
    input(id).addEventListener("input", applyDisplay);
  for (const id of ["tone-mapper", "denoise-algorithm", "glass-mode"]) selectInput(id).addEventListener("change", () => {
    if (id === "denoise-algorithm") input("denoise-radius").value = input("denoise-radius-value").value = selectInput(id).value === "nlm" ? "3" : "2";
    applyDisplay();
  });
  button("apply-nlm").addEventListener("click", () => {
    userPaused = true;
    button("pause").innerHTML = pauseButtonContent(userPaused);
    applyDisplay();
    void renderer.applyNlm().catch(showError);
  });
  selectInput("view").addEventListener("change", () => {
    settle();
    renderer.setDebugView(selectInput("view").value as DebugView);
    syncSettings();
  });
  for (const slider of document.querySelectorAll<HTMLInputElement>(
    "input[type=range]:not([data-log-for])",
  )) {
    if (numericLimits[slider.id]) continue;
    slider.addEventListener("input", () => {
      input(`${slider.id}-value`).value = slider.value;
    });
    input(`${slider.id}-value`).addEventListener("change", () => {
      const number = input(`${slider.id}-value`),
        n = Number(number.value);
      if (
        !Number.isFinite(n) ||
        ((slider.id.startsWith("metal-") || slider.id.startsWith("diffuse-")) && slider.step === "1" && !Number.isInteger(n)) ||
        n < Number(slider.min) ||
        n > Number(slider.max)
      ) {
        number.value = slider.value;
        return;
      }
      slider.value = number.value;
      slider.dispatchEvent(new Event("input"));
    });
  }
  for (const slider of document.querySelectorAll<HTMLInputElement>("[data-log-for]")) {
    const scale = input(slider.dataset.logFor!);
    slider.addEventListener("input", () => {
      scale.value = String(Number(logDistance(Number(slider.value)/1000, Number(scale.min), Number(scale.max)).toPrecision(6)));
      scale.dispatchEvent(new Event("input"));
    });
    scale.addEventListener("change", () => {
      if (!scale.value || !Number.isFinite(Number(scale.value))) scale.value = "1";
      scale.value = String(Math.min(Number(scale.max), Math.max(Number(scale.min), Number(scale.value))));
      scale.dispatchEvent(new Event("input"));
    });
  }
  for (const name of wearEffects) {
    for (const key of ["enabled", "space"]) input(`wear-${name}-${key}`).addEventListener("change", () => {
      syncSettings();
      const scale = input(`wear-${name}-scale`);
      scale.value = String(Math.max(Number(scale.min), Math.min(Number(scale.max), Number(scale.value))));
      syncSettings(); queueScene();
    });
    document.querySelector<HTMLButtonElement>(`[data-wear-seed="${name}"]`)!.addEventListener("click", () => {
      const seed = input(`wear-${name}-seed`), previous = Number(seed.value);
      seed.value = input(`${seed.id}-value`).value = String((previous + 1 + crypto.getRandomValues(new Uint32Array(1))[0]! % 65534 - 1) % 65535 + 1);
      seed.dispatchEvent(new Event("input"));
    });
  }
  attachMiddleReset(controlScene);
  button("reset").addEventListener("click", () => orbit.set({...structuredClone(originalCamera), depthOfField: undefined}));
  button("restart").addEventListener("click", () =>
    renderer.setCamera(currentCamera),
  );
  button("pause").addEventListener("click", () => {
    if (
      userPaused &&
      value("sample-limit") > 0 &&
      lastSamples >= value("sample-limit")
    )
      input("sample-limit").value = "0";
    userPaused = !userPaused;
    button("pause").innerHTML = pauseButtonContent(userPaused);
    if (userPaused) renderer.pause();
    else renderer.resume();
  });
  let exporting = false;
  const exportImage = async (format: "png" | "pfm"): Promise<void> => {
    if (exporting) return;
    exporting = true;
    const wasPaused = userPaused;
    renderer.pause();
    exportStatus.textContent = "Сохраняем изображение…";
    try {
      const sourceRevision = sceneRevision,
        sceneName = selectInput("scene").value,
        material = selectInput("material").value,
        sceneControls = Object.fromEntries(
          [...sceneControlIds, ...textureControlIds].map((id) => [
            id,
            id === "absorption" ? 1 : value(id),
          ]),
        );
      const capture = await renderer.capture();
      if (sourceRevision !== sceneRevision || scenePending)
        throw new DOMException("Scene changed during export", "AbortError");
      const name = `cornell-${selectInput("scene").value}-${capture.settings.mode}-${capture.settings.integrator}-${capture.samples}`;
      if (format === "png")
        download(await renderer.capturePng(), `${name}.png`);
      else {
        download(
          new Blob([encodePfm(capture)], { type: "application/octet-stream" }),
          `${name}.pfm`,
        );
        const {
          linearRgb: _,
          linearXyz: __,
          sampleCounts,
          ...metadata
        } = capture;
        let minCount = Infinity,
          maxCount = 0;
        for (const count of sampleCounts) {
          minCount = Math.min(minCount, count);
          maxCount = Math.max(maxCount, count);
        }
        download(
          new Blob(
            [
              JSON.stringify(
                {
                  ...metadata,
                  environment: environmentUi.metadata(),
                  scene: sceneName,
                  importedObject: sceneName === "uploaded" && uploadedObj ? { filename: uploadedObj.name, triangles: uploadedObj.triangles, solid: uploadedObj.solid, shells: uploadedObj.shells, repairEnabled: input("repair-obj").checked, repair: input("repair-obj").checked ? uploadedObj.repaired?.repair : undefined, glassMode: material === "dielectric" ? materialMetadata(currentModelIsSolid()).actualMode : undefined } : undefined,
                  builtinObject: isBuiltinModel(sceneName) && currentBuiltinModel ? { source: builtinModels[sceneName].source, skippedDegenerateTriangles: currentBuiltinModel.skippedDegenerateTriangles, triangles: currentBuiltinModel.triangles, shells: currentBuiltinModel.shells, solid: currentBuiltinModel.solid, repairEnabled: input("repair-obj").checked, repair: currentBuiltinModel.repair } : undefined,
                  sceneControls,
                  material,
                  materialSettings: materialMetadata(currentModelIsSolid()),
                  materialControls: Object.fromEntries(["material", "ior", "albedo", ...materialControlIds, ...textureControlIds].map(id=>[id,input(id).type==="checkbox"?input(id).checked:readControl(document,id)])),
                  display: {
                    denoiser: input("denoiser").checked,
                    passes: value("denoise-passes"),
                    strength: value("denoise-strength"),
                    ...denoiseControls(),
                    toneMapper: selectInput("tone-mapper").value,
                  },
                  sampleCountRange: [minCount, maxCount],
                },
                null,
                2,
              ),
            ],
            { type: "application/json" },
          ),
          `${name}.json`,
        );
      }
      exportStatus.textContent =
        format === "png"
          ? "PNG сохранён с настройками отображения."
          : "Raw PFM и метаданные сохранены.";
    } catch (error) {
      exportStatus.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      exporting = false;
      if (!wasPaused && !document.hidden) renderer.resume();
    }
  };
  button("export-png").addEventListener("click", () => void exportImage("png"));
  button("export-pfm").addEventListener("click", () => void exportImage("pfm"));
  button("copy-link").addEventListener("click", async () => {
    const message = document.getElementById("share-status")!;
    message.hidden = false;
    try {
      if (scenePending) throw new Error("Дождитесь применения настроек.");
      const link = createSettingsLink(document, location.href, currentCamera);
      await navigator.clipboard.writeText(link);
      message.textContent = "Ссылка скопирована.";
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "Не удалось скопировать ссылку.";
    }
  });
  const observer = new ResizeObserver(() => renderer.resize());
  observer.observe(canvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || userPaused) renderer.pause();
    else renderer.resume();
  });
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) renderer.pause();
    else {
      clearTimeout(idleTimer);
      clearTimeout(sceneTimer);
      sceneRevision++;
      objImporter.cancel();
      observer.disconnect();
      orbit.dispose();
      environmentUi.dispose();
      renderer.dispose();
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !document.hidden && !userPaused) renderer.resume();
  });
  if (startupPreview) {
    interacting = true;
    renderer.setInteracting(true);
  }
  renderer.setSettings(
    startupPreview ? { ...target, ...profiles.preview } : target,
  );
  renderer.setDebugView(startupPreview ? "beauty" : selectInput("view").value as DebugView);
  // Attach rejection handlers immediately while independent preparation overlaps.
  const gpuReady = timeStartup("gpu", () => renderer.prepareGpu());
  const environmentReady = timeStartup("environment", () => environmentUi.initialize());
  void gpuReady.catch(() => {});
  void environmentReady.catch(() => {});
  try {
    if (isBuiltinModel(initialScene)) currentBuiltinModel = await timeStartup("model", () => loadBuiltinObj(initialScene, input("repair-obj").checked));
    const material = hasSharedSettings ? baseMaterial() : initialMaterial;
    const initialDescription = controlScene ? hasSharedSettings ? cornellScene(material) : description : initialScene === "buddha" ? await buddhaScene(material, currentBuiltinModel) : await presentationScene(material, currentBuiltinModel);
    if (hasSharedSettings) {
      const controls = Object.fromEntries(sceneControlIds.map(id => [id, id === "absorption" ? 1 : value(id)])) as SceneControls;
      applySceneControls(initialDescription, controls, selectInput("scene-layout").value !== "open");
      applyTextureControls(initialDescription, Object.fromEntries(textureControlIds.map(id => [id, value(id)])) as TextureControls);
      initialDescription.camera = currentCamera;
      for (const id of ["object-x", "object-y", "object-z"] as const) input(id).value = String(controls[id]);
    }
    applyMaterialEditor(initialDescription, currentBuiltinModel?.solid ?? true);
    applyArrangement(initialDescription);
    await Promise.all([environmentReady, timeStartup("scene", () => renderer.setScene(initialDescription)), gpuReady]);
    await renderer.initialize();
    ready = true;
    committedUi = captureSceneUi();
    if (currentBuiltinModel) objStatus.textContent = describeModel(currentBuiltinModel, initialScene === "buddha" ? "Happy Buddha" : initialScene === "rastagotchi" ? "Rastagotchi" : initialScene === "suzanne-high-poly" ? "Suzanne high poly" : "Suzanne", initialDescription.materials[4]!.type === "dielectric", initialDescription.materials[4]!.type === "dielectric" && !!initialDescription.materials[4]!.thin);
    document
      .querySelectorAll<
        HTMLSelectElement | HTMLInputElement | HTMLButtonElement
      >("select,input,button")
      .forEach((control) => (control.disabled = false));
    syncSettings();
    if (hasSharedSettings) {
      renderer.setExposure(value("exposure"));
      applyDisplay();
    }
    if (!controlScene) {
      if (!hasSharedSettings) input("denoiser").checked = true;
      applyDisplay();

    }
    document.querySelector<HTMLElement>("#scene-name")!.textContent =
      `${initialScene === "control" ? "Sphere" : initialScene === "buddha" ? "Happy Buddha" : initialScene === "rastagotchi" ? "Rastagotchi" : initialScene === "suzanne-high-poly" ? "Suzanne high poly" : "Suzanne"} / ${selectInput("material").selectedOptions[0]!.textContent}`;
  } catch (error) {
    observer.disconnect();
    orbit.dispose();
    renderer.dispose();
    throw error;
  }
}
void start().catch((error) => {
  status.textContent = "Ошибка запуска";
  button("restart").disabled = button("pause").disabled = true;
  errorPanel.hidden = false;
  errorMessage.textContent =
    error instanceof Error ? error.message : String(error);
});
