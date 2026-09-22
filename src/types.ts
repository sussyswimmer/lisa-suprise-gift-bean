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
}

export interface BeanAssetState {
  idle: string;
  noticed: string;
  thinking: string;
  message: string;
  happy: string;
  sleepy: string;
  soundOff: string;
}

export interface BeanManifest {
  version: string;
  states: Record<keyof BeanAssetState, string>;
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
});
