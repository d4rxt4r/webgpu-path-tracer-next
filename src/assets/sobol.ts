export async function loadSobol(): Promise<ArrayBuffer> {
  const response = await fetch(`${import.meta.env.BASE_URL}assets/sobol.bin`);
  if (!response.ok) throw new Error(`Sobol resource: HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  if (data.byteLength !== 512 * 32 * 4) throw new Error('Invalid Sobol resource size');
  return data;
}
