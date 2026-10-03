import metadata from "./buddha-meta.json";
import { meshLoader, parseMesh } from "./mesh";

export const parseBuddha = (data: ArrayBuffer) =>
  parseMesh(data, metadata, "Buddha");
export const loadBuddha = meshLoader(metadata, "Buddha");
