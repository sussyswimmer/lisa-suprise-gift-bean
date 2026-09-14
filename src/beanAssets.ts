import { BeanAssetState, BeanManifest } from "./types";

export const DEFAULT_ASSET_PACK = {
  version: "1.0",
  states: {
    idle: "/bean/placeholder/idle.svg",
    noticed: "/bean/placeholder/noticed.svg",
    thinking: "/bean/placeholder/thinking.svg",
    message: "/bean/placeholder/message.svg",
    happy: "/bean/placeholder/happy.svg",
    sleepy: "/bean/placeholder/sleepy.svg",
    soundOff: "/bean/placeholder/sound-off.svg",
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
