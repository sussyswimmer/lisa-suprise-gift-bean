import { z } from "zod";
import {
  ActivityArt,
  BeanAsset,
  BeanAssetKey,
  BeanManifest,
  IdleActivity,
} from "./types";
import { ACTIVITY_LABELS } from "./activity";

export const DEFAULT_ASSET_PACK: BeanManifest = {
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

const spriteSchema = z.object({
  src: z.string().min(1),
  frames: z.number().int().min(1).max(256),
  fps: z.number().positive().max(60),
  columns: z.number().int().min(1).max(256).optional(),
  rows: z.number().int().min(1).max(256).optional(),
  loop: z.boolean().optional(),
  facing: z.enum(["left", "right"]).optional(),
  scale: z.number().min(0.5).max(2.5).optional(),
});
const assetSchema = z.union([z.string().min(1), spriteSchema]);
const manifestSchema = z.object({
  version: z.string(),
  states: z.object({
    idle: assetSchema,
    noticed: assetSchema,
    thinking: assetSchema,
    message: assetSchema,
    happy: assetSchema,
    sleepy: assetSchema,
    soundOff: assetSchema,
  }),
  motions: z
    .object({ run: assetSchema.optional(), walk: assetSchema.optional() })
    .optional(),
  // A record rather than an object so an unknown activity name from a newer
  // pack is ignored instead of rejecting the whole manifest.
  activities: z.record(z.string(), assetSchema).optional(),
});

function knownActivities(
  activities: Record<string, BeanAsset> | undefined,
): ActivityArt | undefined {
  if (!activities) return undefined;
  return Object.fromEntries(
    Object.entries(activities).filter(
      ([name]) => name !== "breathe" && name in ACTIVITY_LABELS,
    ),
  ) as Partial<Record<IdleActivity, BeanAsset>>;
}

export async function loadManifest(): Promise<BeanManifest> {
  try {
    const resp = await fetch("/bean/manifest.json", { cache: "no-cache" });
    if (!resp.ok) {
      return DEFAULT_ASSET_PACK;
    }
    const parsed = manifestSchema.safeParse(await resp.json());
    if (!parsed.success) return DEFAULT_ASSET_PACK;
    return {
      ...parsed.data,
      activities: knownActivities(parsed.data.activities),
    };
  } catch {
    return DEFAULT_ASSET_PACK;
  }
}

export function assetSource(asset: BeanAsset): string {
  return typeof asset === "string" ? asset : asset.src;
}

/** Start downloading every sheet so a new animation never flashes blank. */
export function preloadAssets(manifest: BeanManifest) {
  if (typeof Image === "undefined") return;
  const assets = [
    ...Object.values(manifest.states),
    ...Object.values(manifest.motions ?? {}),
    ...Object.values(manifest.activities ?? {}),
  ];
  for (const source of new Set(assets.map(assetSource))) {
    new Image().src = source;
  }
}

export function normalizeStatusForAsset(state: string): BeanAssetKey {
  if (state === "thinking") return "thinking";
  if (state === "message") return "message";
  if (state === "happy") return "happy";
  if (state === "sleepy") return "sleepy";
  if (state === "soundOff") return "soundOff";
  if (state === "noticed") return "noticed";
  return "idle";
}
