import { z } from "zod";

export type ClaudeSource = "chat" | "cowork" | "claude_code" | "system";

export type ClaudeStatus =
  | "idle"
  | "working"
  | "thinking"
  | "reply"
  | "message"
  | "attention_needed"
  | "completed"
  | "failed"
  | "stopped"
  | "unavailable";

export type BeanState =
  "idle" | "noticed" | "thinking" | "message" | "happy" | "sleepy" | "soundOff";

export interface ClaudeEvent {
  source: ClaudeSource;
  session: string | null;
  status: ClaudeStatus;
  timestamp: string;
  preview?: string | null;
  reason?: string | null;
  /** The chat's name: a Claude Desktop chat title or Claude Code project. */
  title?: string | null;
}

/** A horizontal or grid sprite sheet, such as a Higgsfield AutoSprite export. */
export interface SpriteAsset {
  src: string;
  frames: number;
  fps: number;
  /** Frames per row; defaults to one row holding every frame. */
  columns?: number;
  /** Rows in the sheet, when it has more than the frames fill (empty cells). */
  rows?: number;
  loop?: boolean;
  /** The way Bean looks in the art, so motion can flip her the right way. */
  facing?: "left" | "right";
  /**
   * Draws the sheet larger than Bean's usual 128 px box, anchored at her feet,
   * for sheets where she is drawn small to leave room for a jump.
   */
  scale?: number;
}

/** A still image path or an animated sprite sheet. */
export type BeanAsset = string | SpriteAsset;

export type BeanAssetKey =
  "idle" | "noticed" | "thinking" | "message" | "happy" | "sleepy" | "soundOff";

export type BeanAssetState = Record<BeanAssetKey, BeanAsset>;

/** Optional movement art used while Bean travels around her window. */
export type BeanMotion = "run" | "walk";

/** Little things Bean does on her own while Claude is quiet. */
export type IdleActivity =
  | "breathe"
  | "peek"
  | "hop"
  | "boba"
  | "zoomies"
  | "patrol"
  | "chase"
  | "stretch"
  | "sniff"
  | "volleyball"
  | "bone"
  | "read"
  | "ball"
  | "music"
  | "dance";

export type ActivityArt = Partial<Record<IdleActivity, BeanAsset>>;

export interface BeanManifest {
  version: string;
  states: BeanAssetState;
  motions?: Partial<Record<BeanMotion, BeanAsset>>;
  /** Sprite sheets for idle activities, such as sipping boba. */
  activities?: ActivityArt;
}

export const claudeEventSchema = z.object({
  source: z.enum(["chat", "cowork", "claude_code", "system"]),
  session: z.string().nullable(),
  status: z.enum([
    "idle",
    "working",
    "thinking",
    "reply",
    "message",
    "attention_needed",
    "completed",
    "failed",
    "stopped",
    "unavailable",
  ]),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  preview: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});
