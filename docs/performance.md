# Оптимизация движка: измерения и границы проверки

> Обновление 04.10.2026: приведённые ниже замеры относятся к оптимизации до исправления транспорта стекла. Текущая корректность, шум и итоговые замеры находятся в [отчёте transport-fix](validation/transport-fix/README.md).

## Контрольный результат

Аппаратный Intel UHD `intel gen-12lp`, Chrome 154.0.8037.58, Windows, WebGPU без software fallback. Сцена Suzanne в Cornell box, стекло N-BK7, 640×480, глубина 32, seed 17. PT: **4 spp**; SPPM: **1 итерация, 16 384 фотона, batch 1024**. Одинаковые камера, геометрия, материалы, разрешение и число выборок. Один прогрев и пять независимых измерений каждой конфигурации; таблица содержит медиану и p95 времени накопления. Подготовка, компиляция и экспорт измеряются отдельно.

| Режим | Исходная версия, median / p95 | Оптимизация, median / p95 | Ускорение median | GPU median до → после |
|---|---:|---:|---:|---:|
| Spectral PT | 4115.9 / 4427.7 ms | 726.7 / 737.5 ms | **5.66×** | 2400.9 → 621.0 ms |
| Spectral SPPM | 5305.3 / 5982.8 ms | 430.9 / 447.3 ms | **12.31×** | 344.6 → 275.4 ms |

Это ускорение фиксированного объёма работы на указанном адаптере, а не обещание FPS на любом GPU. SPPM особенно страдал от ожиданий CPU между короткими GPU-заданиями: устранение этих ожиданий даёт больший выигрыш в общем времени, чем в сумме GPU timestamps.

Медианы по фазам итогового контрольного прогона (суммы внутри прогона, затем медиана пяти прогонов):

| Фаза | GPU, ms | Completion, ms | Dispatch | Submission |
|---|---:|---:|---:|---:|
| PT, 4 spp | 620.95 | 718.3 | 80 | 72 |
| SPPM camera | 88.74 | 122.9 | 80 | 19 |
| SPPM photon | 85.85 | 121.9 | 16 | 16 |
| SPPM gather | 98.44 | 170.5 | 1280 | 18 |
| SPPM update | 3.34 | 8.5 | 1 | 1 |

Медианы отдельных фаз не обязаны суммироваться в медиану всего прогона. Особо короткие gather dispatch теперь группируются; фотонные batch, которые уже достаточно тяжелы, обычно остаются отдельными.

Исходные данные: [baseline](validation/performance-baseline/report.json), [final](validation/performance-final-control/report.json). Исходный commit: `ed090b332c13025caebedf6ba1dc58673fad221e`; снимки исходников идентифицируются `sourceSha256` в отчётах. Для контрольного final хеш `02e5000ded39c0f4a2ebe620a038298be6d7e9d35d831fe86df9aa7cf9d367c2`. Позднейшие форматирование и сохранение поведения проверки неиспользованных вершин отражены в хеше итоговой матрицы.

### Качество изображения

Raw spectral PT совпадает с исходной версией **побитово**. Для spectral SPPM normalized RGB RMSE **5.88e-10**: параллельная атомарная укладка фотонов может менять порядок суммирования float32, но формулы, фотонный бюджет, последовательность Owen–Sobol, MIS, roulette, спектральная дисперсия и правила среды сохранены. В отчётах доступны maximum absolute error, RMSE, изменение среднего и ROI яркости пола/объекта/кадра. PNG фильтра не используется вместо raw численной проверки.

| Артефакт | До | После |
|---|---|---|
| PT raw | [PNG](validation/performance-baseline/suzanne-spectral-pt-17.raw.png), [PFM](validation/performance-baseline/suzanne-spectral-pt-17.pfm) | [PNG](validation/performance-final-control/suzanne-spectral-pt-17.raw.png), [PFM](validation/performance-final-control/suzanne-spectral-pt-17.pfm) |
| PT filtered | [PNG](validation/performance-baseline/suzanne-spectral-pt-17.filtered.png) | [PNG](validation/performance-final-control/suzanne-spectral-pt-17.filtered.png) |
| SPPM raw | [PNG](validation/performance-baseline/suzanne-spectral-sppm-17.raw.png), [PFM](validation/performance-baseline/suzanne-spectral-sppm-17.pfm) | [PNG](validation/performance-final-control/suzanne-spectral-sppm-17.raw.png), [PFM](validation/performance-final-control/suzanne-spectral-sppm-17.pfm) |
| SPPM filtered | [PNG](validation/performance-baseline/suzanne-spectral-sppm-17.filtered.png) | [PNG](validation/performance-final-control/suzanne-spectral-sppm-17.filtered.png) |

Разностные карты `*.difference.ppm` рядом с final: `abs(after-before) × 16`, linear RGB, clamp до 1. Нулевой PT difference — чёрная карта. Один spp или одна SPPM-итерация предназначены для сравнения одинаковой работы, а не для оценки конечного шума изображения.

## Матрица сцен

[Итоговый отчёт](validation/performance-final-matrix/report.json), source hash `1e1adb6df5d35d5ccdda7d4e6f69bee82da03cab772151f8dbbcb46945eeef58`. Все пять сцен × RGB/spectral × PT/SPPM, 160×120, 4 spp PT / 1 SPPM-итерация, seed 17, depth 32. Каждая итоговая строка — пять прогонов после прогрева. [Матрица исходной версии](validation/performance-baseline-matrix/report.json) имеет только один измеренный прогон после прогрева: её отношения полезны как обзор, но статистически слабее контрольного сравнения 640×480.

| Сцена / режим | До, ms | После, median / p95 ms | Отношение до/после | normalized RGB RMSE |
|---|---:|---:|---:|---:|
| Sphere / RGB PT | 229.5 | 44.7 / 46.9 | 5.13× | 0 |
| Sphere / spectral PT | 209.6 | 40.0 / 44.5 | 5.24× | 0 |
| Sphere / RGB SPPM | 477.5 | 141.8 / 163.6 | 3.37× | 2.09e-9 |
| Sphere / spectral SPPM | 504.4 | 137.9 / 145.3 | 3.66× | 4.69e-9 |
| Suzanne / RGB PT | 400.7 | 80.0 / 173.9 | 5.01× | 0 |
| Suzanne / spectral PT | 342.6 | 62.5 / 68.4 | 5.48× | 0 |
| Suzanne / RGB SPPM | 596.5 | 212.3 / 224.5 | 2.81× | 1.95e-10 |
| Suzanne / spectral SPPM | 602.8 | 208.3 / 216.3 | 2.89× | 1.28e-10 |
| Buddha glass / RGB PT | 407.4 | 104.0 / 107.8 | 3.92× | 0 |
| Buddha glass / spectral PT | 395.7 | 85.7 / 92.5 | 4.62× | 0 |
| Buddha glass / RGB SPPM | 644.1 | 237.0 / 242.9 | 2.72× | 2.84e-10 |
| Buddha glass / spectral SPPM | 620.4 | 224.2 / 242.4 | 2.77× | 3.91e-10 |
| Buddha marble / RGB PT | 255.7 | 63.3 / 69.5 | 4.04× | 0 |
| Buddha marble / spectral PT | 244.9 | 50.6 / 68.8 | 4.84× | 0 |
| Buddha marble / RGB SPPM | 456.4 | 140.9 / 165.5 | 3.24× | 1.07e-10 |
| Buddha marble / spectral SPPM | 468.6 | 137.2 / 154.2 | 3.42× | 2.09e-10 |
| Buddha lava / RGB PT | 285.8 | 77.7 / 88.6 | 3.68× | 0 |
| Buddha lava / spectral PT | 258.9 | 63.1 / 81.2 | 4.10× | 0 |
| Buddha lava / RGB SPPM | 485.4 | 147.9 / 165.7 | 3.28× | 9.87e-11 |
| Buddha lava / spectral SPPM | 475.1 | 161.7 / 166.2 | 2.94× | 1.12e-10 |

Во всех 10 PT-конфигурациях raw совпадает побитово. Максимальный normalized RMSE среди SPPM-конфигураций — 4.69e-9. Нулевые GPU errors, ровные sampleCounts и одинаковые photon counts проверены runner; raw/filtered PNG и PFM каждой сцены сохранены рядом с отчётами.

## Проверка физики и длительного накопления

`npm test`: **36/36**; `npm run build`: TypeScript и production build успешны. Полный браузерный набор: **36/36**, затем новый sampler-тест и повторный SPPM-набор: **6/6** (37 уникальных браузерных тестов).

Проверены closest/any-hit на 2088 лучах и на Buddha с шести сторон; диагностика диапазона, нечисловых значений и stack overflow; Fresnel/Snell/TIR; аналитическое поглощение с внутренними отражениями; независимые интегралы MIS/light/BSDF и roulette; спектральные нормировки и CPU quadrature каустики. Стеклянный Buddha прошёл 22 108 176 путей на двух разрешениях без ошибок среды. Призма photon pass: footprint spread 0.08909 для дисперсии, 0 для постоянного IOR, position error 4.26e-5, relative flux error 5.53e-6. UI/capture/filter, partial reset, camera/scene replacement, скрытая вкладка, DPR 3 и настоящий device destroy/recovery также проверены.

Новый `sampler.spec.ts` проверяет 2496 комбинаций: восемь seeds, включая `0xffffffff`; индексы до `0xffffffff`; размеры Sobol до 450; разные pixels. Специализированный и исходный GPU sampler, а также независимый CPU sampler совпадают **точно**, max error = 0.

[PBRT acceptance после оптимизации](validation/performance-quality/stage10-quality.json): Suzanne 32×24, 2048 SPPM-итерации × 8192 фотона = 16 777 216 фотонов, batch 4096, seed 17. Проверены depth 32, depth 64 и radius 0.06; нулевые GPU errors и sample count 2048 каждого пикселя. Эталон — существующие PBRT v4 depth 64, 32768 spp, seeds 17/29; hash экспортированной сцены проверен перед reuse, PBRT заново не запускался.

| ROI, depth32/radius0.03 | Относительная ошибка яркости против PBRT |
|---|---:|
| Пол | 3.3712% (порог 5%) |
| Комната | 1.6345% |
| Стекло | 2.4897% |

Для доказательства сохранения качества отдельно выполнен тот же длинный GPU-прогон на исходном commit: [original acceptance](validation/performance-quality-original/stage10-quality.json). Raw RGB PFM после 2048 итераций **побитово одинаковы** у исходной и оптимизированной версии; ROI и RMSE против PBRT также одинаковы. Старый исторический `stage10-quality.json` не используется как baseline движка: именно текущий исходный commit воспроизведён заново.

Fallback проверен на настоящем устройстве без timestamp-query, shader-f16 и subgroups. Persistent allocations при повторной смене PT/SPPM и сцен вернулись к тем же размерам (4 538 352 / 1 716 208 bytes), без накопления ресурсов; DPR 3 не нарушает pixel/memory budget.

[Full HD](validation/performance-full-hd/report.json): Suzanne spectral PT depth 32, 1920×1080, 1 spp, один измеренный прогон после прогрева — 860.9 ms wall / 723.6 ms GPU, 153.5 MiB persistent GPU allocations, нулевые ошибки, каждый пиксель имеет 1 sample. Этот одиночный прогон проверяет масштабирование и бюджет; он не используется для заявления об ускорении или конечном качестве при 1 spp.

[Edge smoke](validation/performance-edge-smoke/report.json): аппаратный Intel gen-12lp, Edge 154.0.4258.53, Suzanne spectral PT/SPPM, 160×120. Sample counts корректны, PT совпадает с исходным raw точно, SPPM normalized RMSE 4.46e-10. Основная статистика ускорения получена в Chrome; для Edge выполнена функциональная проверка с одним прогоном, без отдельной оценки ускорения.

## Что изменено

- Несколько dispatch в одном submission; неизменяемые снимки uniforms копируются перед соответствующим dispatch в порядке команд. Два submission одновременно, затем оба readback полностью завершаются. Общие параметры не перезаписываются для уже закодированного dispatch.
- Задания ограничены одной фазой и границей полного spp/SPPM-итерации. Пауза, сброс сцены, export и device loss не допускают публикацию устаревшего накопления. Progress сообщает фактически выполненную фазу, число dispatch и submissions.
- `MessageChannel` устраняет задержку вложенных таймеров. Во время взаимодействия используется RAF и один пакет; скрытая вкладка приостанавливается. Бюджет пакета подстраивается по timestamp или по completion latency при отсутствии timestamp-query.
- PT использует сетку адаптивных плиток 16–256 px. Измеренный Intel gen-12lp начинает с 128; остальные адаптеры с 64. Размер меняется только между полными spp. Это сохраняет ровно одну выборку на пиксель при изменении сетки. Ориентир бюджета не является жёсткой гарантией времени отдельного тяжёлого dispatch.
- GPU timestamps и диагностика объединены в один readback на пакет. Финальное отображение кодируется в том же submission. Exposure/tonemapper используют уже вычисленный фильтр; новые raw данные и изменения настроек фильтра сбрасывают кэш.
- Преобразования общих вершин кэшируются. SAH использует float64 bounds/centroids, стабильное разбиение и повторно используемые typed scratch arrays. GPU packing заполняет массивы напрямую с отражёнными WGSL offsets. Формат GPU-данных, стабильный порядок треугольников, расширение bounds и глубина BVH сохранены.
- Координатный shear треугольника и обратное направление slab-теста вычисляются один раз на луч. Нулевые компоненты направления обрабатываются отдельной веткой. Watertight triangle test и диагностика переполнения стека сохранены.
- SPPM сокращает консервативный stencil gather при уменьшении радиуса. На измеренном Intel используется специализация тех же 24 уровней Owen scramble с заранее вычисленными константами. PT и остальные адаптеры сохраняют компактный цикл: глобальное разворачивание ухудшало PT.
- Запрашивается high-performance adapter с fallback к обычному запросу. Требуется только базовый WebGPU; timestamps опциональны. `shader-f16`/subgroups не включаются без доказательства выигрыша и численной эквивалентности. Основные расчёты остаются на GPU.

Постоянные дополнительные ресурсы планировщика: два буфера снимков по 64 KiB при стандартном alignment, второй диагностический readback; они включены в лимит памяти. Размеры накопления ограничиваются существующими бюджетами памяти и аппаратными buffer limits. Экспорт дополнен `computation`: sampler, kernel, scheduler, workgroup, выбранный размер следующей плитки, специализация SPPM. Существующие настройки и данные экспорта сохранены.

Подготовка Suzanne после рефактора занимает порядка 0.57–0.76 s; предыдущие замеры — 1.75–3.78 s. Это wall time подготовки с worker и передачей данных, чувствительное к прогреву и нагрузке CPU; нельзя трактовать максимальную разницу как чистый выигрыш SAH. Парные этапы [ray-shear](validation/performance-ray-shear/report.json) и [preparation](validation/performance-preparation/report.json) показывают 1754 → 574 ms для PT и 2022 → 586 ms для SPPM.

## Проверенные альтернативы

Прототипы находятся в `scripts/performance-*.mjs`, загружаются только benchmark runner и не входят в приложение. Решения принимались по одинаковому объёму работы; для полной смены архитектуры требовался существенный выигрыш (10% и более).

| Эксперимент | Измерение | Решение |
|---|---|---|
| [Wavefront с GPU compaction и indirect dispatch](validation/performance-wavefront/report.json) | 2110.7 ms против [megakernel на тех же 128 px](validation/performance-megakernel-128/report.json) 883.2 ms; raw совпадает | Не принят: 2.39× медленнее. Сравнение с маленькими плитками было бы некорректным |
| [BVH4](validation/performance-bvh4/report.json) | 868.0 ms против 883.2 ms, raw совпадает | Не принят: около 1.7%, недостаточно для изменения layout и всех потребителей |
| [CSR count/scan/scatter photon hash](validation/performance-csr/report.json) | 512.4 ms против [linked hash](validation/performance-sppm-specialized/report.json) 497.2 ms | Не принят: дополнительные проходы дороже; normalized RMSE 1.09e-9 |
| [Geometry/normal split](validation/performance-compact/report.json) | 3343.3 ms против 3119.5 ms в той конфигурации | Не принят: замедление |
| [Кэш расстояний в traversal stack](validation/performance-cached-bounds/report.json) | 1139.9 ms против 883.2 ms | Не принят: больше состояния на луч и замедление |
| Workgroup [32](validation/performance-workgroup-32/report.json) / [128](validation/performance-workgroup-128/report.json) / [256](validation/performance-workgroup-256/report.json) | 3093.0 / 3112.5 / 3224.6 ms против 3119.5 ms (все плитки 48 px) | Сохранён 8×8: нет убедительного выигрыша; самые большие группы хуже |
| [Leaf size 8](validation/performance-leaf-8/report.json) | PT 3277.3 ms, SPPM 503.5 ms | Сохранён leaf 4 |
| [Разворачивание sampler в обоих integrators](validation/performance-sampler-unrolled/report.json) | SPPM быстрее, PT медленнее | Только SPPM, только измеренный Intel; математически та же последовательность |

Этапные отчёты имеют разные source hashes и настройки плиток. Их нельзя смешивать как результаты одного финального варианта. Старые `portions` означают callback после завершения пакета/пары пакетов; новые отчёты дополнительно содержат точное поле `submissions`. GPU timestamps относятся к integrator, без presentation/denoiser; completion включает очередь и последний display. Median/p95 строятся по отдельным прогонам, а не по объединённым фазам.

## Воспроизведение

```powershell
npm run benchmark -- --tag current-control --cases suzanne --modes spectral-pt,spectral-sppm --width 640 --height 480 --pt 4 --sppm 1
npm run benchmark -- --tag current-matrix --pt 4 --sppm 1 --compare baseline-matrix
npm test
npm run build
npm run test:browser
node scripts/acceptance.mjs --reuse-reference --output docs/validation/performance-quality
```

Runner запускает собственный Vite и Chrome на пустой странице без второго активного renderer, выполняет прогрев, останавливает renderer синхронно на точной границе, проверяет sampleCounts каждого пикселя, сохраняет отчёт, raw PFM, raw/filtered PNG и разностную карту. `--images no` отключает PNG/PFM для экспериментов. Raw JSON — локальный ignored cache для повторного сравнения; при его отсутствии runner читает переносимый PFM. Для сравнения с исходным commit можно распаковать `git archive --format=zip --output .performance-cache/baseline.zip ed090b332c13025caebedf6ba1dc58673fad221e src` в ignored `.performance-cache/baseline` и передать `--source /.performance-cache/baseline/src`. Не менять `src` и не запускать другие GPU-задачи во время измерения.

PBRT reference reuse проверяет hash экспортируемой сцены и исходное число PBRT spp перед использованием сохранённых двух reference seeds; записывает новые результаты в отдельный каталог. Для новой сцены требуется обычный запуск с `--pbrt <PBRT v4 executable>`. Повторное использование reference не является повторным запуском внешнего PBRT.

Подтверждены результаты на одном физическом адаптере. Проверка baseline device без optional features подтверждает работоспособность fallback, но не заменяет измерений AMD/NVIDIA/Apple. До измерений на этих GPU специализация остаётся консервативной.
