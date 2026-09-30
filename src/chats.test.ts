import { describe, expect, it } from "vitest";
import {
  ChatActivity,
  DONE_VISIBLE_MS,
  chatName,
  updateChats,
  visibleChats,
} from "./chats";
import { ClaudeEvent } from "./types";

const at = (second: number) =>
  new Date(Date.UTC(2026, 8, 30, 0, 0, second)).toISOString();

function event(
  status: ClaudeEvent["status"],
  session: string | null,
  second: number,
  extra: Partial<ClaudeEvent> = {},
): ClaudeEvent {
  return { source: "chat", session, status, timestamp: at(second), ...extra };
}

function apply(...events: ClaudeEvent[]) {
  return events.reduce<ChatActivity[]>(updateChats, []);
}

describe("chats Bean follows", () => {
  it("names each running chat after its title", () => {
    const chats = apply(
      event("working", "chat/a", 0, { title: "Trip ideas" }),
      event("working", "chat/b", 1, { title: "Tax questions" }),
    );
    expect(chats.map(chatName)).toEqual(["Trip ideas", "Tax questions"]);
    expect(chats.every((chat) => chat.status === "working")).toBe(true);
  });

  it("keeps a chat's title when later updates leave it out", () => {
    const chats = apply(
      event("working", "chat/a", 0, { title: "Trip ideas" }),
      event("completed", "chat/a", 5),
    );
    expect(chats).toMatchObject([{ title: "Trip ideas", status: "done" }]);
  });

  it("keeps a chat replying in the background when another one opens", () => {
    const chats = apply(
      event("working", "chat/a", 0, { title: "Trip ideas" }),
      event("idle", "chat/b", 3, { title: "Tax questions" }),
    );
    expect(chats).toMatchObject([{ title: "Trip ideas", status: "working" }]);
  });

  it("treats Chat and Cowork as the same chat", () => {
    const chats = apply(
      event("working", "task/a", 0),
      event("attention_needed", "task/a", 2, { source: "cowork" }),
    );
    expect(chats).toHaveLength(1);
    expect(chats[0].status).toBe("attention");
  });

  it("drops Claude Desktop chats when Claude goes away", () => {
    const chats = apply(
      event("working", "chat/a", 0),
      event("working", "s1", 1, { source: "claude_code", title: "bean" }),
      event("unavailable", null, 2, { source: "system" }),
    );
    expect(chats.map(chatName)).toEqual(["bean"]);
  });

  it("puts chats that need you first and hides finished ones", () => {
    const chats = apply(
      event("completed", "chat/a", 0, { title: "Done" }),
      event("working", "chat/b", 1, { title: "Busy" }),
      event("attention_needed", "s1", 2, { source: "claude_code" }),
    );
    const now = Date.parse(at(3));
    expect(visibleChats(chats, now, null).map(chatName)).toEqual([
      "Claude Code",
      "Busy",
      "Done",
    ]);
    expect(
      visibleChats(chats, now + DONE_VISIBLE_MS, null).map(chatName),
    ).toEqual(["Claude Code", "Busy"]);
  });

  it("forgets a background chat after a while, but not the one on screen", () => {
    const chats = apply(event("working", "chat/a", 0));
    const later = Date.parse(at(0)) + 6 * 60_000;
    expect(visibleChats(chats, later, null)).toEqual([]);
    expect(visibleChats(chats, later, "desktop:chat/a")).toHaveLength(1);
  });
});
