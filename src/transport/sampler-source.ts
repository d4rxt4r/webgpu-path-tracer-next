import reference from "./sampler.wgsl?raw";
import { hash32 } from "./sampler";

// SPPM benefits from specializing fixed levels; PT keeps the smaller looped
// shader because the unrolled variant regressed on the measured Intel adapter.
const start = reference.indexOf(
  "  for (var level = 0u; level < 24u; level++) {",
);
const end = reference.indexOf("\n  }", start);
if (start < 0 || end < start)
  throw new Error("Owen sampler specialization marker missing");
const body = reference.slice(reference.indexOf("\n", start) + 1, end);
export const sppmSamplerSource =
  reference.slice(0, start) +
  Array.from(
    { length: 24 },
    (_, level) =>
      "  {\n" +
      body
        .replaceAll("hash32(level)", `${hash32(level)}u`)
        .replaceAll("level", `${level}u`) +
      "\n  }",
  ).join("\n") +
  reference.slice(end + 4);
export const referenceSamplerSource = reference;
