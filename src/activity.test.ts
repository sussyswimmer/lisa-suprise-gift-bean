import { describe, expect, it } from "vitest";
import { activitiesFor, motionFor, nextActivity } from "./activity";

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
});
