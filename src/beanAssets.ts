import { BeanAssetState, BeanManifest } from "./types";

export const DEFAULT_ASSET_PACK = {
  version: "1.0",
  states: {
    idle: "/bean/generated/idle.png",
    noticed: "/bean/generated/idle.png",
    thinking: "/bean/generated/working.png",
    message: "/bean/generated/idle.png",
    happy: "/bean/generated/idle.png",
    sleepy: "/bean/generated/idle.png",
    soundOff: "/bean/generated/idle.png",
  },
};

export async function loadManifest(): Promise<BeanManifest> {
  try {
    const resp = await fetch("/bean/manifest.json", { cache: "no-cache" });
    if (!resp.ok) {
      return DEFAULT_ASSET_PACK;
    }
    const data = (await resp.json()) as BeanManifest;
    return data?.states ? data : DEFAULT_ASSET_PACK;
  } catch {
    return DEFAULT_ASSET_PACK;
  }
}

export function normalizeStatusForAsset(state: string): keyof BeanAssetState {
  if (state === "thinking") return "thinking";
  if (state === "message") return "message";
  if (state === "happy") return "happy";
  if (state === "sleepy") return "sleepy";
  if (state === "soundOff") return "soundOff";
  if (state === "noticed") return "noticed";
  return "idle";
}
