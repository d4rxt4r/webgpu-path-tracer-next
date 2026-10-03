import metadata from "./suzanne-meta.json";
import { meshLoader, parseMesh } from "./mesh";

export const parseSuzanne = (data: ArrayBuffer) =>
  parseMesh(data, metadata, "Suzanne");
export const loadSuzanne = meshLoader(metadata, "Suzanne");
