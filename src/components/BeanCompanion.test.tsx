// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BeanCompanion from "./BeanCompanion";
import { spriteFramePosition } from "./BeanSprite";
import { BeanState, SpriteAsset } from "../types";

const run: SpriteAsset = {
  src: "/bean/sprites/run.png",
  frames: 8,
  fps: 12,
  facing: "right",
};

function companion(state: BeanState) {
  return (
    <BeanCompanion
      state={state}
      asset={state === "thinking" ? "/working.png" : "/idle.png"}
      restAsset="/idle.png"
      motions={{ run }}
      statusText="Waiting and watching"
      source="chat"
      session={null}
      preview={null}
      onDragStart={() => undefined}
    />
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Bean animations", () => {
  it("runs to the laptop when Claude starts working, then types", () => {
    const view = render(companion("idle"));
    view.rerender(companion("thinking"));
    const stage = view.container.querySelector(".bean-stage");
    expect(stage?.className).toContain("idle-activity-arrive");
    const sprite = view.container.querySelector<HTMLElement>(".is-sprite");
    expect(sprite?.style.backgroundImage).toContain("run.png");
    expect(view.container.querySelector(".faces-right")).toBeTruthy();

    act(() => vi.advanceTimersByTime(250));
    expect(Number(sprite?.dataset.frame)).toBeGreaterThan(0);

    act(() => vi.advanceTimersByTime(1_000));
    expect(stage?.className).toContain("idle-activity-breathe");
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/working.png",
    );
    expect(view.container.querySelector(".typing-pixels")).toBeTruthy();
  });

  it("plays one activity at a time and settles back to breathing", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.45);
    const view = render(companion("idle"));
    const stage = () => view.container.querySelector(".bean-stage")!.className;
    act(() => vi.advanceTimersByTime(8_600));
    expect(stage()).not.toContain("idle-activity-breathe");
    act(() => vi.advanceTimersByTime(6_300));
    expect(stage()).toContain("idle-activity-breathe");
    vi.restoreAllMocks();
  });

  it("steps through horizontal and grid sprite sheets", () => {
    expect(spriteFramePosition(run, 0)).toEqual({
      backgroundSize: "800% 100%",
      backgroundPosition: "0% 0%",
    });
    expect(spriteFramePosition(run, 7).backgroundPosition).toBe("100% 0%");
    const grid = { ...run, frames: 6, columns: 3 };
    expect(spriteFramePosition(grid, 4)).toEqual({
      backgroundSize: "300% 200%",
      backgroundPosition: "50% 100%",
    });
  });
});
