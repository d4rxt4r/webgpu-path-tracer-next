import { afterEach, describe, expect, it, vi } from "vitest";
import { attachMiddleReset, numericDefault } from "../src/app/settings-reset";
import { nbk7Ior } from "../src/transport/spectrum";

class Field extends EventTarget {
  disabled = false;
  constructor(public id: string, public type: string, public value: string, public dataset: Record<string, string> = {}) { super(); }
}

function setup() {
  const fields = {
    material: new Field("material", "select", "blue-glass"),
    scene: new Field("scene", "select", "suzanne"),
    exposure: new Field("exposure", "range", "2", { default: "0" }),
    "exposure-value": new Field("exposure-value", "number", "2", { default: "0" }),
    seed: new Field("seed", "number", "9"),
  };
  vi.stubGlobal("document", {
    getElementById: (id: keyof typeof fields) => fields[id],
    querySelectorAll: () => [fields.exposure, fields["exposure-value"], fields.seed],
  });
  return fields;
}

function mouse(field: Field, type: string, button = 1) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "button", { value: button });
  field.dispatchEvent(event);
  return event;
}

afterEach(() => vi.unstubAllGlobals());

describe("middle button reset", () => {
  it("uses current material and scene rather than preset values", () => {
    const fields = setup();
    expect(numericDefault("ior", false)).toBe(1.7);
    fields.material.value = "glass";
    expect(numericDefault("ior", false)).toBe(1.5);
    fields.material.value = "nbk7-constant";
    expect(numericDefault("ior", false)).toBe(nbk7Ior(587.6));
    fields.scene.value = "buddha";
    expect(numericDefault("object-y", false)).toBe(0.86);
    fields.scene.value = "control";
    expect(numericDefault("object-y", false)).toBe(0.65);
    fields.material.value = "lava";
    expect(numericDefault("texture-width", false)).toBe(0.04);
    expect(numericDefault("max-depth", true)).toBe(8);
    expect(numericDefault("max-depth", false)).toBe(32);
  });

  it("routes number reset through its slider and suppresses duplicate or disabled edits", () => {
    const fields = setup();
    const applied = vi.fn(() => { fields["exposure-value"].value = fields.exposure.value; });
    fields.exposure.addEventListener("input", applied);
    attachMiddleReset(false);
    expect(mouse(fields["exposure-value"], "mousedown").defaultPrevented).toBe(true);
    expect(mouse(fields["exposure-value"], "auxclick").defaultPrevented).toBe(true);
    expect([fields.exposure.value, fields["exposure-value"].value]).toEqual(["0", "0"]);
    expect(applied).toHaveBeenCalledTimes(1);
    mouse(fields.exposure, "auxclick");
    expect(applied).toHaveBeenCalledTimes(1);
    fields.exposure.value = "3";
    fields.exposure.disabled = true;
    mouse(fields.exposure, "auxclick");
    expect(fields.exposure.value).toBe("3");
    fields.exposure.disabled = false;
    mouse(fields.exposure, "auxclick", 2);
    expect(fields.exposure.value).toBe("3");
    const seedChange = vi.fn();
    fields.seed.addEventListener("change", seedChange);
    mouse(fields.seed, "auxclick");
    expect(fields.seed.value).toBe("1");
    expect(seedChange).toHaveBeenCalledTimes(1);
  });
});
