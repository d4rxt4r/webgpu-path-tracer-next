import type { MeshData } from "../scene/types";

interface MeshMetadata {
  asset: string;
  byteLength: number;
  sha256: string;
  triangles: number;
  finalStatistics: { vertices: number };
}

export function parseMesh(
  data: ArrayBuffer,
  metadata: MeshMetadata,
  name: string,
): MeshData {
  const fail = (part: string): never => {
    throw new Error(`Invalid ${name} mesh ${part}`);
  };
  if (
    data.byteLength !== metadata.byteLength ||
    data.byteLength < 32 ||
    new TextDecoder().decode(new Uint8Array(data, 0, 8)) !== "SGMESH01"
  )
    fail("header");
  const header = new DataView(data),
    vertices = header.getUint32(8, true),
    triangles = header.getUint32(12, true);
  const positionsOffset = header.getUint32(16, true),
    normalsOffset = header.getUint32(20, true),
    indicesOffset = header.getUint32(24, true);
  if (
    vertices !== metadata.finalStatistics.vertices ||
    triangles !== metadata.triangles ||
    positionsOffset !== 32 ||
    normalsOffset !== 32 + vertices * 12 ||
    indicesOffset !== 32 + vertices * 24 ||
    indicesOffset + triangles * 12 !== data.byteLength ||
    header.getUint32(28, true) !== 0
  )
    fail("layout");
  const positions = new Float32Array(data, positionsOffset, vertices * 3),
    normals = new Float32Array(data, normalsOffset, vertices * 3),
    indices = new Uint32Array(data, indicesOffset, triangles * 3);
  if (
    !positions.every(Number.isFinite) ||
    !normals.every(Number.isFinite) ||
    indices.some((index) => index >= vertices)
  )
    fail("values");
  for (let i = 0; i < vertices; i++)
    if (
      Math.abs(
        Math.hypot(normals[3 * i]!, normals[3 * i + 1]!, normals[3 * i + 2]!) -
          1,
      ) > 1e-5
    )
      fail("normal");
  return { positions, normals, indices };
}

/** Cache the checked CPU resource; GPU allocations remain owned by the renderer. */
export function meshLoader(
  metadata: MeshMetadata,
  name: string,
): () => Promise<MeshData> {
  let pending: Promise<MeshData> | undefined;
  return () =>
    (pending ??= (async () => {
      const response = await fetch(
        `${import.meta.env.BASE_URL}assets/${metadata.asset}`,
      );
      if (!response.ok)
        throw new Error(`${name} resource: HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", data);
      const checksum = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (checksum !== metadata.sha256)
        throw new Error(`${name} mesh checksum mismatch`);
      return parseMesh(data, metadata, name);
    })().catch((error) => {
      pending = undefined;
      throw error;
    }));
}
