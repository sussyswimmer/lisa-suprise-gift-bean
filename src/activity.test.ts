import { describe, expect, it } from "vitest";
import {
  activitiesFor,
  activityDurationMs,
  motionFor,
  nextActivity,
  restDelayMs,
} from "./activity";

describe("Bean idle activities", () => {
  it("never repeats the activity that just played", () => {
    for (const random of [0, 0.3, 0.6, 0.999]) {
      expect(nextActivity("idle", "zoomies", () => random)).not.toBe("zoomies");
    }
  });
  it("keeps a drowsy Bean from racing around", () => {
    expect(activitiesFor("sleepy")).not.toContain("zoomies");
    expect(activitiesFor("sleepy")).not.toContain("patrol");
    expect(activitiesFor("idle")).toContain("zoomies");
    expect(activitiesFor("thinking")).toEqual(["breathe"]);
  });
  it("uses running art for zoomies and for arriving at the laptop", () => {
    expect(motionFor("zoomies")).toBe("run");
    expect(motionFor("arrive")).toBe("run");
    expect(motionFor("patrol")).toBe("walk");
    expect(motionFor("sniff")).toBeNull();
  });
  it("offers prop activities only when their sprite sheet exists", () => {
    expect(activitiesFor("idle")).not.toContain("volleyball");
    const available = new Set(["volleyball", "boba"] as const);
    expect(activitiesFor("idle", { available })).toContain("volleyball");
    expect(activitiesFor("idle", { available })).not.toContain("dance");
  });
  it("skips activities switched off in Settings", () => {
    const disabled = ["zoomies", "boba", "peek"];
    const choices = activitiesFor("idle", { disabled });
    for (const name of disabled) expect(choices).not.toContain(name);
    expect(choices).toContain("sniff");
    for (const random of [0, 0.5, 0.999])
      expect(disabled).not.toContain(
        nextActivity("idle", "breathe", () => random, { disabled }),
      );
  });
  it("just breathes when every activity is switched off", () => {
    const disabled = activitiesFor("idle");
    expect(nextActivity("idle", "breathe", () => 0.5, { disabled })).toBe(
      "breathe",
    );
  });
  it("plays a looping sheet twice and rests for the chosen frequency", () => {
    const sheet = { src: "/boba.png", frames: 24, fps: 10 };
    expect(activityDurationMs("boba", sheet)).toBe(4_800);
    expect(activityDurationMs("boba")).toBe(4_200);
    expect(restDelayMs("calm", () => 0)).toBe(14_000);
    expect(restDelayMs("lively", () => 0.999)).toBeLessThan(6_000);
  });
});
