import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSET_PACK, loadManifest } from "./beanAssets";
import { claudeEventSchema } from "./types";

afterEach(() => vi.unstubAllGlobals());
describe("external data validation", () => {
  it("falls back if any animation is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "1", states: { idle: "/idle.png" } }),
      }),
    );
    expect(await loadManifest()).toBe(DEFAULT_ASSET_PACK);
  });
  it("accepts a complete asset pack", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => DEFAULT_ASSET_PACK }),
    );
    expect(await loadManifest()).toEqual(DEFAULT_ASSET_PACK);
  });
  it("accepts animated sprite sheets and running art", async () => {
    const pack = {
      ...DEFAULT_ASSET_PACK,
      states: {
        ...DEFAULT_ASSET_PACK.states,
        happy: {
          src: "/bean/sprites/jump.png",
          frames: 12,
          fps: 14,
          scale: 1.4,
        },
      },
      motions: {
        run: { src: "/bean/sprites/run.png", frames: 8, fps: 12, columns: 4 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => pack }),
    );
    expect(await loadManifest()).toEqual(pack);
  });
  it("falls back when a sprite sheet is malformed", async () => {
    const pack = {
      ...DEFAULT_ASSET_PACK,
      states: {
        ...DEFAULT_ASSET_PACK.states,
        happy: { src: "/bean/sprites/jump.png", frames: 0, fps: 14 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => pack }),
    );
    expect(await loadManifest()).toBe(DEFAULT_ASSET_PACK);
  });
  it("rejects malformed native events before rendering", () => {
    const event = {
      source: "chat",
      session: null,
      status: "working",
      timestamp: "2026-09-22T00:00:00Z",
    };
    expect(claudeEventSchema.safeParse(event).success).toBe(true);
    expect(claudeEventSchema.safeParse({ ...event, preview: {} }).success).toBe(
      false,
    );
    expect(
      claudeEventSchema.safeParse({ ...event, timestamp: "invalid" }).success,
    ).toBe(false);
    expect(
      claudeEventSchema.safeParse({ ...event, status: "unknown" }).success,
    ).toBe(false);
  });
});
