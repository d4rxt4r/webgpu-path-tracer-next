import type { SurfaceWear, SurfaceWearV2, WearEffect } from "./types";

export const wearEffects = ["scratches", "scuffs", "fingerprints"] as const;
export type WearName = typeof wearEffects[number];
export interface WearField { key: keyof WearEffect; label: string; min: number; max: number; step: number; help: string }
const field = (key: keyof WearEffect, label: string, min: number, max: number, step: number, help: string): WearField => ({key, label, min, max, step, help});
export const wearCommonFields = [
  field("intensity", "Сила", 0, 1, .01, "Общая сила следов. Ноль полностью исключает эффект из расчёта."),
  field("seed", "Seed рисунка", 1, 65535, 1, "Собственный рисунок эффекта; не зависит от seed рендера и других следов."),
];
const roughness = field("roughness", "Матовость, ×", 0, 2, .01, "Вклад следов в шероховатость стекла относительно исходного рисунка."),
  relief = field("relief", "Микрорельеф, ×", 0, 2, .01, "Отклонение нормали поверхности. Геометрия и силуэт не меняются."),
  direction = field("direction", "Направление, °", -180, 180, 1, "Поворот рисунка в его локальных проекциях."),
  variation = field("variation", "Разброс размеров, ×", 0, 2, .01, "Ноль делает размеры одинаковыми; один сохраняет исходный разброс.");
export const wearDetailFields: Record<WearName, WearField[]> = {
  scratches: [field("coverage", "Покрытие", 0, 1, .01, "Доля ячеек с царапиной. Размер рисунка также изменяет расстояния между следами."),
    field("length", "Длина, ×", .1, 1.3, .01, "Длина царапин внутри ячейки; предел сохраняет гладкие окончания без швов."),
    field("width", "Ширина, ×", .1, 5, .01, "Толщина бороздок. Увеличьте её, если следы мельче пикселя."), variation, direction,
    field("spread", "Разброс направлений, °", 0, 180, 1, "Ноль задаёт параллельные царапины; 180 — случайные направления."), roughness, relief],
  scuffs: [field("coverage", "Покрытие пятнами", 0, 1, .01, "Площадь потёртых участков; ноль выключает эффект."),
    field("softness", "Мягкость границ", .01, .4, .01, "Ширина плавного перехода между чистой и потёртой поверхностью."),
    field("grainScale", "Размер зерна, ×", .05, 20, .01, "Большое значение делает зерно крупнее."),
    field("grainContrast", "Контраст зерна, ×", 0, 2, .01, "Неравномерность матовости внутри пятен."), direction,
    field("abrasionScale", "Размер повреждений, ×", .05, 20, .01, "Размер мелких направленных повреждений микрорельефа."), roughness, relief],
  fingerprints: [field("count", "Количество", 0, 32, 1, "Количество следов на каждой проекции. Видимое число зависит от формы и ракурса."),
    field("aspect", "Ширина / высота, ×", .25, 3, .01, "Пропорции овального отпечатка относительно исходной формы."), variation, direction,
    field("spread", "Разброс поворота, °", 0, 180, 1, "Случайное отклонение отпечатков от выбранного направления."),
    field("ridgeSpacing", "Шаг линий, ×", .25, 5, .01, "Расстояние между папиллярными линиями."),
    field("ridgeWidth", "Ширина линий, ×", .25, 3, .01, "Толщина линий при неизменном шаге."),
    field("rubbed", "Степень стирания", 0, 1, .01, "Ноль оставляет целые отпечатки; один стирает их полностью."),
    field("contrast", "Контраст линий, ×", 0, 2, .01, "Дополнительная матовость линий относительно общего следа."), roughness],
};
export function defaultWearEffect(name: WearName): WearEffect {
  return { enabled: false, intensity: .5, scale: 1, space: "model", seed: 1, roughness: 1,
    coverage: name === "scratches" ? .55 : .5, length: 1, width: 1, variation: 1,
    direction: 0, spread: name === "fingerprints" ? 1.5 * 180 / Math.PI : 180, relief: 1,
    grainScale: 1, grainContrast: 1, softness: .15, abrasionScale: 1, count: 3,
    aspect: 1, ridgeSpacing: 1, ridgeWidth: 1, rubbed: .5, contrast: 1 };
}
export const cleanSurface: SurfaceWearV2 = { version: 2, scratches: defaultWearEffect("scratches"), scuffs: defaultWearEffect("scuffs"), fingerprints: defaultWearEffect("fingerprints") };
export const rastagotchiWear: SurfaceWearV2 = { version: 2,
  scratches: {...defaultWearEffect("scratches"), enabled: true}, scuffs: {...defaultWearEffect("scuffs"), enabled: true}, fingerprints: {...defaultWearEffect("fingerprints"), enabled: true} };
export function normalizeSurfaceWear(wear?: SurfaceWear): SurfaceWearV2 {
  if (!wear) return structuredClone(cleanSurface);
  if ("version" in wear) {
    if (wear.version !== 2) throw new Error("Invalid dielectric surface wear version");
    return structuredClone(wear);
  }
  return { version: 2, ...Object.fromEntries(wearEffects.map(name => [name, {
    ...defaultWearEffect(name), enabled: wear[name] > 0, intensity: wear[name] || .5, seed: wear.seed,
  }])) } as SurfaceWearV2;
}
export function validateSurfaceWear(wear: SurfaceWear): void {
  if (!("version" in wear) && (![wear.scratches, wear.scuffs, wear.fingerprints].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    || !Number.isInteger(wear.seed) || wear.seed < 1 || wear.seed > 65535)) throw new Error("Invalid dielectric surface wear");
  const normalized = normalizeSurfaceWear(wear);
  for (const name of wearEffects) {
    const effect = normalized[name];
    if (!effect || typeof effect.enabled !== "boolean" || !["model", "scene"].includes(effect.space)
      || !Number.isFinite(effect.scale) || effect.scale < (effect.space === "model" ? .05 : .00001) || effect.scale > (effect.space === "model" ? 20 : 1000)) throw new Error("Invalid dielectric surface wear scale");
    for (const f of [...wearCommonFields, ...wearDetailFields[name]]) {
      const v = effect[f.key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < f.min || v > f.max || (f.step === 1 && ["seed", "count"].includes(f.key) && !Number.isInteger(v))) throw new Error(`Invalid dielectric surface wear ${name}.${f.key}`);
    }
  }
}
export function effectActive(name: WearName, e: WearEffect): boolean {
  return e.enabled && e.intensity > 0 && (e.roughness > 0 || (name !== "fingerprints" && e.relief > 0))
    && (name === "fingerprints" ? e.count > 0 && e.rubbed < 1 : e.coverage > 0);
}
export function surfaceWearMask(wear?: SurfaceWear): number {
  const w = normalizeSurfaceWear(wear);
  return wearEffects.reduce((mask, name, i) => mask | (effectActive(name, w[name]) ? 1 << i : 0), 0);
}
export function hasSurfaceWear(wear?: SurfaceWear): boolean { return surfaceWearMask(wear) !== 0; }
export const wearControlIds = wearEffects.flatMap(name => [`wear-${name}-enabled`, `wear-${name}-space`, `wear-${name}-scale`,
  ...[...wearCommonFields, ...wearDetailFields[name]].map(f => `wear-${name}-${f.key}`)]);
export function packWearEffect(name: WearName, e: WearEffect) {
  return { base: [e.scale, e.seed, Number(e.space === "scene"), e.roughness],
    shape: name === "scratches" ? [e.length, e.width, e.variation, e.coverage]
      : name === "scuffs" ? [e.grainScale, e.grainContrast, e.coverage, e.softness] : [e.count, e.aspect, e.variation, e.ridgeSpacing],
    detail: name === "scratches" ? [e.direction * Math.PI / 180, e.spread * Math.PI / 180, e.relief, 0]
      : name === "scuffs" ? [e.direction * Math.PI / 180, e.relief, e.abrasionScale, 0] : [e.ridgeWidth, e.rubbed, e.contrast, e.direction * Math.PI / 180],
    extra: [e.spread * Math.PI / 180, 0, 0, 0] };
}
