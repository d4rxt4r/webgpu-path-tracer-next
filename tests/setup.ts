// Reflection uses these spec-defined flags; no GPU implementation is mocked.
Object.assign(globalThis, { GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } });
