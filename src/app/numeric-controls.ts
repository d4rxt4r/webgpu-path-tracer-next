import { numericLimits, validNumeric } from "../scene/numeric-settings";
export { numericLimits, validNumeric } from "../scene/numeric-settings";
const accepted = new WeakMap<HTMLInputElement, string>();
export function readControl(root: ParentNode, id: string): string {
  const field = root.querySelector<HTMLInputElement>(`#${id}${numericLimits[id] ? '-value' : ''}`)!;
  return accepted.get(field) ?? field.value;
}
export function writeControl(root: ParentNode, id: string, raw: string): void {
  const slider = root.querySelector<HTMLInputElement>(`#${id}`)!;
  slider.value = raw;
  if (numericLimits[id]) {
    const number = root.querySelector<HTMLInputElement>(`#${id}-value`)!;
    number.value = raw; accepted.set(number, raw);
  }
}
export function bindNumericControls(root: ParentNode, onError: (error: Error) => void): void {
  for (const [id, limits] of Object.entries(numericLimits)) {
    const slider = root.querySelector<HTMLInputElement>(`#${id}`), number = root.querySelector<HTMLInputElement>(`#${id}-value`);
    if (!slider || !number) continue;
    number.min = String(limits[0]); number.max = String(limits[1]);
    accepted.set(number, number.value);
    slider.addEventListener('input', event => {
      if (!(event instanceof CustomEvent && event.detail === 'numeric')) writeControl(root, id, slider.value);
    }, true);
    number.addEventListener('change', () => {
      const raw = number.value;
      if (!validNumeric(id, raw)) {
        writeControl(root, id, accepted.get(number)!);
        onError(new Error(`Допустимый диапазон ${id}: ${limits[0]}–${limits[1]}${id === 'fov' ? ' (верхняя граница исключена)' : ''}.`));
        return;
      }
      writeControl(root, id, raw);
      slider.dispatchEvent(new CustomEvent('input', { bubbles: true, detail: 'numeric' }));
    });
  }
}
