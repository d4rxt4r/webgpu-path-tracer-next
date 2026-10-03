export interface DeviceInfo {
  adapter: GPUAdapter;
  device: GPUDevice;
  name: string;
}

export async function createDevice(): Promise<DeviceInfo> {
  if (!isSecureContext) throw new Error("WebGPU требует HTTPS или localhost.");
  if (!navigator.gpu)
    throw new Error(
      "WebGPU недоступен. Откройте приложение в Chrome или Edge с включённым аппаратным ускорением.",
    );
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "low-power",
  });
  if (!adapter)
    throw new Error(
      "Не найден доступный WebGPU-адаптер. Проверьте драйвер GPU и аппаратное ускорение браузера.",
    );
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has("timestamp-query")
      ? ["timestamp-query"]
      : [],
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(
        adapter.limits.maxStorageBufferBindingSize,
        256 * 1048576,
      ),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1048576),
    },
  });
  const info = adapter.info;
  return {
    adapter,
    device,
    name:
      info.description ||
      [info.vendor, info.architecture].filter(Boolean).join(" ") ||
      "WebGPU adapter",
  };
}

export async function checkedShader(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length)
    throw new Error(
      `${label}: ${errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join("\n")}`,
    );
  return module;
}
