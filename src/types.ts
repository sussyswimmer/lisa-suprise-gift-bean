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

export type BeanState = "idle" | "noticed" | "thinking" | "message" | "happy" | "sleepy" | "soundOff";

export interface ClaudeEvent {
  source: ClaudeSource;
  session: string | null;
  status: ClaudeStatus;
  timestamp: string;
  preview?: string | null;
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
