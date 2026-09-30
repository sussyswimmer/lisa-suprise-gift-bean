import { ClaudeEvent, ClaudeSource } from "./types";

export type ChatStatus = "working" | "attention" | "done";

/** One Claude chat or Claude Code session that Bean shows above her head. */
export interface ChatActivity {
  key: string;
  source: ClaudeSource;
  title: string | null;
  status: ChatStatus;
  /** When this chat last reported, in milliseconds since the epoch. */
  updatedAt: number;
}

/** How long a finished chat stays in the list. */
export const DONE_VISIBLE_MS = 8_000;
// Claude Desktop only reports the chat on screen, so a chat left replying in
// the background drops off after a while; Claude Code sessions expire with
// the helper's own session timeout.
const STALE_MS = { desktop: 5 * 60_000, claude_code: 30 * 60_000 };

/** Chats from Chat and Cowork share a key: the mode can flip mid-reply. */
export function chatKey(event: Pick<ClaudeEvent, "source" | "session">) {
  if (event.source === "system") return null;
  const origin = event.source === "claude_code" ? "claude_code" : "desktop";
  return `${origin}:${event.session ?? "current"}`;
}

function isStale(chat: ChatActivity, now: number, currentKey: string | null) {
  if (chat.status === "done") return now - chat.updatedAt >= DONE_VISIBLE_MS;
  if (chat.key === currentKey) return false;
  const limit =
    chat.source === "claude_code" ? STALE_MS.claude_code : STALE_MS.desktop;
  return now - chat.updatedAt >= limit;
}

/** Applies one helper event to the list of chats Bean is following. */
export function updateChats(
  chats: ChatActivity[],
  event: ClaudeEvent,
): ChatActivity[] {
  const at = Date.parse(event.timestamp);
  const kept = chats.filter((chat) => !isStale(chat, at, null));
  if (event.status === "unavailable") {
    // Claude Desktop went away; Claude Code sessions report on their own.
    return event.source === "claude_code"
      ? kept
      : kept.filter((chat) => chat.source === "claude_code");
  }
  const key = chatKey(event);
  if (!key) return kept;
  const status: ChatStatus | null =
    event.status === "working" ||
    event.status === "thinking" ||
    event.status === "reply"
      ? "working"
      : event.status === "attention_needed"
        ? "attention"
        : event.status === "completed"
          ? "done"
          : null;
  const previous = kept.find((chat) => chat.key === key);
  const others = kept.filter((chat) => chat.key !== key);
  if (!status) return others;
  return [
    ...others,
    {
      key,
      source: event.source,
      title: event.title?.trim() || previous?.title || null,
      status,
      updatedAt: at,
    },
  ];
}

const ORDER: Record<ChatStatus, number> = { attention: 0, working: 1, done: 2 };

/** The chats to show now: waiting ones first, then the newest. */
export function visibleChats(
  chats: ChatActivity[],
  now: number,
  currentKey: string | null,
) {
  return chats
    .filter((chat) => !isStale(chat, now, currentKey))
    .sort(
      (a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt,
    );
}

export function chatName(chat: ChatActivity) {
  if (chat.title) return chat.title;
  return chat.source === "claude_code"
    ? "Claude Code"
    : chat.source === "cowork"
      ? "Cowork"
      : "Claude";
}
