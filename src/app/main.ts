import "./style.css";
import { renderEditor } from "./editor-ui";
import { createDevice } from "../gpu/device";
import { cornellScene } from "../scene/cornell";
import type { SphereMaterial } from "../scene/cornell";
import { presentationScene } from "../scene/presentation";
import { attachOrbit } from "./orbit";
import { profiles } from "./profiles";
import type { Profile } from "./profiles";
import type { PathSettings, DebugView } from "../render/intersection-renderer";
import { download, encodePfm } from "./export";
import { nbk7Ior } from "../transport/spectrum";
import { applySceneControls, sceneControlIds } from "../scene/editor";
import type { SceneControls } from "../scene/editor";

const controlScene =
  new URLSearchParams(location.search).get("scene") === "control";
document.querySelector<HTMLDivElement>("#app")!.innerHTML =
  renderEditor(controlScene);

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
const description = cornellScene(controlScene ? "diffuse" : "blue-glass");
if (!controlScene) {
  input("ior").value = input("ior-value").value = "1.7";
}
selectInput("scene").value = controlScene ? "control" : "suzanne";
selectInput("material").value = controlScene ? "diffuse" : "blue-glass";
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
    const material = selectInput("material").value;
    input("dispersion").disabled = !material.startsWith("nbk7");
    input("dispersion").checked = material === "nbk7";
    input("ior").disabled = input("ior-value").disabled =
      material === "diffuse" || material === "nbk7";
    input("absorption").disabled = input("absorption-value").disabled =
      material === "diffuse";
    input("albedo").disabled = input("albedo-value").disabled =
      material !== "diffuse";
    for (const id of ["denoise-passes", "denoise-strength"])
      input(id).disabled = input(`${id}-value`).disabled =
        !input("denoiser").checked;
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
    errorPanel.textContent =
      error instanceof Error ? error.message : String(error);
  }
  let currentCamera = description.camera,
    sceneRevision = 0;
  const applyTarget = (): void => {
    if (!interacting) renderer.setSettings(target);
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
  const updateScene = async (revision: number): Promise<void> => {
    activity.textContent = "Подготовка сцены…";
    const material = selectInput("material").value as SphereMaterial;
    const scene =
      selectInput("scene").value === "suzanne"
        ? await presentationScene(material)
        : cornellScene(material);
    if (revision !== sceneRevision) return;
    const controls = Object.fromEntries(
      sceneControlIds.map((id) => [id, value(id)]),
    ) as SceneControls;
    applySceneControls(scene, controls);
    for (const id of ["object-x", "object-y", "object-z"] as const)
      input(id).value = String(controls[id]);
    syncRanges();
    scene.camera = currentCamera;
    try {
      await renderer.setScene(scene);
      if (revision === sceneRevision) {
        scenePending = false;
        errorPanel.hidden = true;
        document.querySelector<HTMLElement>("#scene-name")!.textContent =
          `${selectInput("scene").value === "suzanne" ? "Suzanne" : "Sphere"} / ${material}`;
      }
    } catch (error) {
      if (revision === sceneRevision) showError(error);
    }
  };
  const queueScene = (): void => {
    scenePending = true;
    button("export-png").disabled = button("export-pfm").disabled = true;
    clearTimeout(sceneTimer);
    const revision = ++sceneRevision;
    sceneTimer = setTimeout(
      () => void updateScene(revision).catch(showError),
      80,
    );
  };
  selectInput("scene").addEventListener("change", () => {
    input("object-y").value =
      selectInput("scene").value === "suzanne" ? "1" : "0.65";
    syncRanges();
    queueScene();
  });
  selectInput("material").addEventListener("change", () => {
    input("ior").value = String(
      selectInput("material").value === "blue-glass"
        ? 1.7
        : selectInput("material").value === "glass"
          ? 1.5
          : nbk7Ior(587.6),
    );
    syncSettings();
    queueScene();
  });
  input("dispersion").addEventListener("change", () => {
    selectInput("material").value = input("dispersion").checked
      ? "nbk7"
      : "nbk7-constant";
    syncSettings();
    queueScene();
  });
  selectInput("profile").addEventListener("change", () => {
    profile = selectInput("profile").value as Profile;
    if (profile !== "custom") {
      target = { ...target, ...profiles[profile] };
      input("denoiser").checked = profile === "quality";
      applyDisplay();
    }
    applyTarget();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-profile]").forEach((b) =>
    b.addEventListener("click", () => {
      selectInput("profile").value = b.dataset.profile!;
      selectInput("profile").dispatchEvent(new Event("change"));
    }),
  );
  const pathControls: Record<string, keyof PathSettings> = {
    mode: "mode",
    integrator: "integrator",
    resolution: "maxPixels",
    strategy: "strategy",
    "max-depth": "maxDepth",
    seed: "seed",
    photons: "photonsPerIteration",
    batch: "photonBatchSize",
    radius: "initialRadius",
    "memory-budget": "memoryBudgetMiB",
  };
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
          const previous = target;
          target = { ...target, [key]: next };
          profile = "custom";
          try {
            applyTarget();
          } catch (error) {
            target = previous;
            syncSettings();
            showError(error);
          }
        },
      );
  selectInput("memory-profile").addEventListener("change", () => {
    target.memoryBudgetMiB = Number(selectInput("memory-profile").value);
    applyTarget();
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
    "light-power",
    "light-size",
    "light-x",
    "light-z",
    "wall-neutral",
    "wall-red",
    "wall-green",
    "ior",
    "absorption",
    "albedo",
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
          sceneControlIds.map((id) => [id, value(id)]),
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
                  scene: sceneName,
                  sceneControls,
                  material,
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
      observer.disconnect();
      orbit.dispose();
      renderer.dispose();
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !document.hidden && !userPaused) renderer.resume();
  });
  renderer.setDebugView("beauty");
  if (!controlScene) {
    interacting = true;
    renderer.setInteracting(true);
  }
  renderer.setSettings(
    controlScene ? target : { ...target, ...profiles.preview },
  );
  try {
    await renderer.setScene(
      controlScene ? description : await presentationScene(),
    );
    await renderer.initialize();
    ready = true;
    document
      .querySelectorAll<
        HTMLSelectElement | HTMLInputElement | HTMLButtonElement
      >("select,input,button")
      .forEach((control) => (control.disabled = false));
    syncSettings();
    if (!controlScene) {
      input("denoiser").checked = true;
      applyDisplay();
      idleTimer = setTimeout(settle, 250);
    }
    document.querySelector<HTMLElement>("#scene-name")!.textContent =
      controlScene ? "Sphere / diffuse" : "Suzanne / blue-glass";
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
  errorPanel.textContent =
    error instanceof Error ? error.message : String(error);
});
