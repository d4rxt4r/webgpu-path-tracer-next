export const settingHelp: Record<string, string> = {
  view: "Диагностическое отображение рендера. BVH показывает число посещённых узлов до первой поверхности; плотность фотонов доступна в SPPM.",
  profile: "Preview — быстрый RGB PT. Reference — спектральный PT. Quality — спектральный SPPM с каустиками. Full HD, QHD и 4K задают увеличенные бюджеты для мощных GPU.",
  mode: "RGB переносит три цветовых компонента. Спектральный режим моделирует длины волн и позволяет получить дисперсию стекла; шум может уходить медленнее.",
  integrator: "Path tracing накапливает пути от камеры. SPPM дополнительно испускает фотоны от источников для каустик. При смене интегратора накопление начинается заново.",
  resolution: "Максимальный пиксельный бюджет, а не фиксированный размер. Фактическое разрешение зависит от области просмотра, DPR, бюджета памяти и лимитов GPU. Больше пикселей — больше памяти и времени.",
  "max-depth": "Максимальное число взаимодействий пути с поверхностями. Увеличение помогает сложным отражениям и преломлениям, но повышает стоимость рендера и память фотонного пакета.",
  strategy: "MIS объединяет выборку света и BSDF. Light only и BSDF only полезны для сравнения; могут давать больше шума. В SPPM выбор фиксирован движком.",
  seed: "Начальное число генератора случайных выборок. Одинаковое значение помогает воспроизводить рендер при одинаковых настройках.",
  "sample-limit": "Цель накопления: samples для PT, итерации для SPPM. 0 — без ограничения. При достижении цели рендер приостанавливается.",
  "auto-preview": "При движении камеры временно используется быстрый Preview. Выбранный режим возвращается после 250 мс покоя.",
  fov: "Вертикальный угол обзора камеры. Больший угол вмещает больше сцены и усиливает перспективу.",
  "camera-distance": "Расстояние до цели камеры в метрах. Вращение и приближение сохраняют цель; сброс камеры возвращает исходный ракурс.",
  "repair-obj": "Закрыть простые отверстия и исправить ориентацию поверхности в Worker. Добавляет грани и может менять вид модели. Выключение возвращает исходную геометрию. Каждая связанная оболочка ремонтируется отдельно. Самопересечения и сложные разрывы не восстанавливаются. При ошибке одной оболочки сохраняется весь исходный OBJ с тонким стеклом.",
  "import-obj": "Загрузить OBJ с геометрией и нормалями локально. Все группы объединяются; MTL и внешние текстуры не загружаются. Модель автоматически вписывается в комнату. До 128 MiB и 2 млн треугольников.",
  "object-rotation-x": "Поворот объекта вокруг оси X в градусах. Вращения применяются в порядке X → Y → Z.",
  "object-rotation-z": "Поворот объекта вокруг оси Z в градусах. Вращения применяются в порядке X → Y → Z.",
  scene: "Объект в Cornell box. Смена объекта перестраивает геометрию и начинает накопление заново.",
  "object-scale": "Масштаб объекта. Допустимый размер зависит от объекта; положение ограничивается стенами комнаты.",
  "object-x": "Горизонтальное положение объекта в метрах. Ограничивается размерами комнаты и объекта.",
  "object-y": "Высота объекта в метрах. Положение ограничивается полом и потолком.",
  "object-z": "Положение объекта по глубине комнаты в метрах. Ограничивается стенами.",
  "object-rotation": "Поворот объекта вокруг вертикальной оси Y в градусах.",
  "light-power": "Мощность излучения потолочного источника. Меняет освещение сцены и сбрасывает накопление; экспозиция меняет только отображение.",
  "light-size": "Размер потолочного источника в метрах. Влияет на мягкость теней, каустики и суммарный свет при той же яркости.",
  "light-x": "Смещение потолочного источника по оси X в метрах.",
  "light-z": "Смещение потолочного источника по оси Z в метрах.",
  "wall-neutral": "Отражательная способность нейтральных стен. Более высокое значение усиливает непрямое освещение.",
  "wall-red": "Множитель отражения красной стены. Влияет на цвет света, отражённого в сцену.",
  "wall-green": "Множитель отражения зелёной стены. Влияет на цвет света, отражённого в сцену.",
  material: "Материал объекта. Для открытых OBJ стекло автоматически становится тонким: отражает и пропускает свет без объёмного преломления, поглощения и линзовых каустик. N-BK7 использует спектральные данные стекла; мрамор и лава используют объёмный процедурный рисунок.",
  dispersion: "Зависимость показателя преломления N-BK7 от длины волны по Sellmeier. Видимое разделение цветов требует спектрального переноса; ручной IOR при дисперсии отключён.",
  ior: "Показатель преломления стекла: влияет на отражение и изгиб лучей. Для дисперсионного N-BK7 определяется автоматически.",
  absorption: "Множитель поглощения света внутри стекла. Чем длиннее путь в стекле, тем сильнее окрашивание. Меняет RGB и спектральные коэффициенты.",
  albedo: "Доля света, отражаемого диффузным материалом. 0 — чёрный, 1 — максимальное отражение.",
  "texture-scale": "Частота объёмного рисунка, закреплённого на объекте. Большее значение делает рисунок мельче.",
  "texture-turbulence": "Сила искажения процедурного рисунка; увеличивает извилистость прожилок.",
  "texture-width": "Ширина прожилок мрамора или светящихся участков лавы.",
  "texture-coating": "Доля полированного отражающего покрытия поверхности.",
  "lava-power": "Мощность свечения лавы. Лава освещает окружающие поверхности.",
  "lava-temperature": "Температура свечения в кельвинах. Меняет цвет излучения лавы.",
  photons: "Число фотонных путей на итерацию SPPM. Больше путей уменьшает шум фотонной оценки, но удлиняет итерацию. Память зависит прежде всего от размера пакета.",
  batch: "Число фотонных путей в одном пакете. Большие пакеты требуют больше памяти и увеличивают длительность GPU-задачи; ограничиваются возможностями устройства.",
  radius: "Начальный радиус поиска фотонов в метрах. Малый радиус уточняет каустику, но требует больше фотонов. По мере накопления радиус уменьшается.",
  exposure: "Экспозиция отображения: +1 EV удваивает яркость. Не меняет исходное накопление.",
  "tone-mapper": "Преобразование HDR в экранный диапазон. Reinhard сжимает яркости, ACES fit меняет контраст и цвет, Linear обрезает значения вне диапазона.",
  denoiser: "Фильтр à-trous уменьшает видимый шум по данным первых поверхностей. Исходное накопление и Raw PFM не меняются.",
  "denoise-passes": "Количество проходов фильтра. Больше проходов сильнее сглаживает изображение и увеличивает время обработки.",
  "denoise-strength": "Сила сглаживания шума. Большое значение может размывать детали.",
  "filter-glass": "Применять фильтр к стеклу. По умолчанию выключено: первая поверхность не описывает преломлённый фон, поэтому фильтр может размывать детали и каустики.",
  "memory-profile": "Готовый бюджет памяти приложения. Это не измеренный объём VRAM. Большой бюджет позволяет повысить разрешение, но не отменяет лимиты GPU.",
  "memory-budget": "Мягкий бюджет GPU-ресурсов рендера в MiB. При нехватке памяти разрешение уменьшается. Фактические лимиты и доступность памяти зависят от GPU и браузера.",
  "export-png": "Экспорт последнего полного прохода в PNG с текущими настройками отображения.",
  "export-pfm": "Экспорт линейного RGB в Raw PFM и параметров в JSON после полного прохода. Сохраняет отрицательные компоненты; экранный фильтр и tone mapping не применяются.",
  restart: "Начать накопление заново с текущими настройками сцены и камеры.",
};

export function attachSettingsHelp(): void {
  const tooltip = document.createElement("div");
  tooltip.id = "settings-tooltip";
  tooltip.className = "settings-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  let active: HTMLElement | undefined;
  let pinned = false;
  const close = () => {
    active?.removeAttribute("aria-describedby");
    active = undefined;
    pinned = false;
    tooltip.hidden = true;
  };
  const show = (icon: HTMLElement, text: string) => {
    if (active !== icon) close();
    active = icon;
    tooltip.textContent = text;
    tooltip.hidden = false;
    icon.setAttribute("aria-describedby", tooltip.id);
    const rect = icon.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - box.height - 8))}px`;
  };
  for (const [id, description] of Object.entries(settingHelp)) {
    const control = document.getElementById(id);
    if (!control) continue;
    const numeric = control instanceof HTMLInputElement && ["range", "number"].includes(control.type);
    const text = description + (numeric ? " Нажатие колёсика — сброс к значению по умолчанию." : "");
    const icon = document.createElement("span");
    icon.className = "setting-info";
    icon.textContent = "i";
    icon.tabIndex = 0;
    icon.setAttribute("role", "button");
    const label = control.closest("label");
    const name = label?.querySelector("span")?.textContent || label?.textContent || control.textContent || id;
    icon.setAttribute("aria-label", `Подсказка: ${name.trim()}`);
    // Avoid nested interactive controls inside labels and export buttons.
    if (label) {
      label.classList.add("has-setting-info");
      label.after(icon);
      const wrapper = document.createElement("div");
      wrapper.className = "setting-row";
      label.before(wrapper);
      wrapper.append(label, icon);
    } else {
      const wrapper = document.createElement("div");
      wrapper.className = "setting-row";
      control.before(wrapper);
      wrapper.append(control, icon);
    }
    icon.addEventListener("pointerenter", () => show(icon, text));
    icon.addEventListener("pointerleave", () => { if (!pinned && document.activeElement !== icon) close(); });
    icon.addEventListener("focus", () => show(icon, text));
    icon.addEventListener("blur", close);
    icon.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); show(icon, text); pinned = true; });
    icon.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(icon, text); pinned = true; }
    });
  }
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  document.addEventListener("pointerdown", event => { if (active && !active.contains(event.target as Node)) close(); });
  document.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
}
