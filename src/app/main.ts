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
import { renderEditor } from "./editor-ui";
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
const value = (id: string): number => Number(input(id).value);
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
function applyRastagotchiPreset(): void {
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
  input("texture-width").value = "0.04";
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
  for (const slider of document.querySelectorAll<HTMLInputElement>(
    "input[type=range]",
  ))
    input(`${slider.id}-value`).value = slider.value;
}
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
  input("radius").value = String(target.initialRadius);
  input("memory-budget").value = String(target.memoryBudgetMiB);
  const memoryProfile = selectInput("memory-profile");
  memoryProfile.value = Array.from(memoryProfile.options).some(option => option.value === String(target.memoryBudgetMiB)) ? String(target.memoryBudgetMiB) : "custom";
  document
    .querySelectorAll<HTMLButtonElement>("[data-profile]")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.profile === profile),
    );
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
    for (const id of ["denoise-passes", "denoise-strength"])
      input(id).disabled = input(`${id}-value`).disabled = !input("denoiser").checked;
    input("filter-glass").disabled = !input("denoiser").checked;
    button("export-png").disabled = button("export-pfm").disabled =
      lastSamples === 0 ||
      selectInput("view").value !== "beauty" ||
      interacting ||
      scenePending;
  }
  syncRanges();
}
syncSettings();
if (query.get('settings') === '1' && query.get('scene-layout') === 'open') {
  for (const id of ['object-x', 'object-y', 'object-z', 'object-scale']) for (const suffix of ['', '-value']) {
    input(id + suffix).min = id === 'object-scale' ? '.01' : '-10';
    input(id + suffix).max = '10';
  }
}
const linkedCamera = restoreSettingsLink(document, query, description.camera);
const hasSharedSettings = linkedCamera !== undefined;
if (linkedCamera) {
  description.camera = linkedCamera;
  input("camera-distance").value = String(Math.hypot(...linkedCamera.position.map((v, i) => v - linkedCamera.target[i]!)));
  for (const [id, key] of Object.entries(pathControls)) {
    const raw = document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value;
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
      document.querySelector<HTMLElement>("#progress")!.textContent = progress;
      activity.textContent = interacting
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
      const goal = value("sample-limit");
      if (
        ready &&
        goal > 0 &&
        info.samples >= goal &&
        info.status === "ready" &&
        !interacting &&
        !userPaused
      ) {
        userPaused = true;
        button("pause").textContent = "Продолжить";
        renderer.pause();
      }
      button("pause").disabled =
        info.status === "error" || info.status === "recovering";
      if (ready)
        button("export-png").disabled = button("export-pfm").disabled =
          lastSamples === 0 ||
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
    // Explicit edits take effect immediately, including during camera preview.
    renderer.setSettings(target);
    if (interacting) {
      clearTimeout(idleTimer);
      interacting = false;
      renderer.setInteracting(false);
    }
    syncSettings();
  };
  const applyDisplay = (): void => {
    renderer.setDisplay({
      enabled: input("denoiser").checked,
      passes: value("denoise-passes"),
      strength: value("denoise-strength"),
      filterGlass: input("filter-glass").checked,
      toneMapper: selectInput("tone-mapper").value as
        | "reinhard"
        | "aces"
        | "linear",
    });
    syncSettings();
  };
  const settle = (): void => {
    clearTimeout(idleTimer);
    interacting = false;
    renderer.setInteracting(false);
    renderer.setSettings(target);
    syncSettings();
  };
  const orbit = attachOrbit(canvas, description.camera, (camera) => {
    currentCamera = camera;
    input("fov").value = String(camera.verticalFov);
    input("camera-distance").value = String(
      Math.hypot(...camera.position.map((v, i) => v - camera.target[i]!)),
    );
    syncRanges();
    if (
      input("auto-preview").checked &&
      selectInput("view").value === "beauty"
    ) {
      clearTimeout(idleTimer);
      interacting = true;
      renderer.setInteracting(true);
      renderer.setSettings({ ...target, ...profiles.preview });
      idleTimer = setTimeout(settle, 250);
    }
    renderer.setCamera(camera);
  });
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
  const captureSceneUi = () => Object.fromEntries(sceneFields.map(id => { const control = document.getElementById(id) as HTMLInputElement; return [id, control.type === "checkbox" ? control.checked : control.value]; }));
  let committedUi = captureSceneUi();
  let committedRepair = input("repair-obj").checked;
  const restoreSceneUi = () => {
    uploadedObj = committedObj;
    textures.restore(committedTextures);
    input("repair-obj").checked = committedRepair;
    const option = selectInput("scene").querySelector<HTMLOptionElement>('[value="uploaded"]');
    if (uploadedObj && option) option.textContent = uploadedObj.name;
    else option?.remove();
    for (const [id, value] of Object.entries(committedUi)) { const control = document.getElementById(id) as HTMLInputElement; if (typeof value === "boolean") control.checked = value; else control.value = value; }
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
      resetObject();
      objStatus.textContent = `Подготовка ${file.name}…`;
      await updateScene(revision);
    } catch (error) {
      if (revision === sceneRevision) { restoreSceneUi(); objStatus.textContent = "Импорт не выполнен; предыдущий объект сохранён."; showError(error); }
    }
  });
  selectInput("scene").addEventListener("change", () => { resetObject(); if (selectInput("scene").value === "rastagotchi") applyRastagotchiPreset(); syncSettings(); queueScene(); });
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
  document.querySelectorAll<HTMLButtonElement>("[data-profile]").forEach((b) =>
    b.addEventListener("click", () => {
      selectInput("profile").value = b.dataset.profile!;
      selectInput("profile").dispatchEvent(new Event("change"));
    }),
  );
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
              : Number(control.value);
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
    input("memory-budget").value = selected;
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
  ])
    input(id).addEventListener("input", queueScene);
  for (const id of ["fov", "camera-distance"])
    input(id).addEventListener("input", () => {
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
  for (const id of ["denoiser", "filter-glass"])
    input(id).addEventListener("change", applyDisplay);
  for (const id of ["denoise-passes", "denoise-strength"])
    input(id).addEventListener("input", applyDisplay);
  selectInput("tone-mapper").addEventListener("change", applyDisplay);
  selectInput("view").addEventListener("change", () => {
    settle();
    renderer.setDebugView(selectInput("view").value as DebugView);
    syncSettings();
  });
  for (const slider of document.querySelectorAll<HTMLInputElement>(
    "input[type=range]",
  )) {
    slider.addEventListener("input", () => {
      input(`${slider.id}-value`).value = slider.value;
    });
    input(`${slider.id}-value`).addEventListener("change", () => {
      const number = input(`${slider.id}-value`),
        n = Number(number.value);
      if (
        !Number.isFinite(n) ||
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
  attachMiddleReset(controlScene);
  button("reset").addEventListener("click", () => orbit.reset());
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
    button("pause").textContent = userPaused ? "Продолжить" : "Пауза";
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
                  display: {
                    denoiser: input("denoiser").checked,
                    passes: value("denoise-passes"),
                    strength: value("denoise-strength"),
                    filterGlass: input("filter-glass").checked,
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
  if (!controlScene && !hasSharedSettings) {
    interacting = true;
    renderer.setInteracting(true);
  }
  renderer.setSettings(
    controlScene || hasSharedSettings ? target : { ...target, ...profiles.preview },
  );
  renderer.setDebugView(selectInput("view").value as DebugView);
  try {
    if (isBuiltinModel(initialScene)) currentBuiltinModel = await loadBuiltinObj(initialScene, input("repair-obj").checked);
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
    await environmentUi.initialize();
    await renderer.setScene(initialDescription);
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
      if (!hasSharedSettings) idleTimer = setTimeout(settle, 250);
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
  button("pause").disabled = true;
  errorPanel.hidden = false;
  errorMessage.textContent =
    error instanceof Error ? error.message : String(error);
});
