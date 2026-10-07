import {expect,it} from "vitest";
import {sppmShader} from "../src/transport/sppm-shader";
import {pathShader} from "../src/transport/shaders";
import {rgbPathShader} from "../src/transport/pt-source";
import {fastTransportShader} from "../src/transport/fast-source";
import {mediumCapacityShader} from "../src/transport/medium-source";

it("common kernels exclude the precise journal and retain no precision calls", () => {
  for (const source of [pathShader,rgbPathShader(),sppmShader]) {
    const common=fastTransportShader(source);
    expect(common).not.toMatch(/MediumJournal|MediumUndo|beginMediumAtSurface|finishMediumAtSurface|originLow|preciseTriangleHit/);
    expect(common).toContain("previewMediumChange(&media");
    expect(common).toContain("applyMediumChange(&media");
  }
});

it("SPPM capacity specialization preserves the independent full repair source", () => {
  for (const capacity of [2,4,8,32] as const) {
    const common=mediumCapacityShader(sppmShader,capacity);
    expect(common).toContain(`const MEDIUM_CAPACITY: u32 = ${capacity}u;`);
    expect(sppmShader).toContain("const MEDIUM_CAPACITY: u32 = 32u;");
  }
  expect(()=>mediumCapacityShader("",4)).toThrow("Missing medium capacity");
});
