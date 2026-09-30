import { useEffect, useState, type MouseEvent } from "react";
import { BeanAsset, BeanMotion, BeanState } from "../types";
import {
  ACTIVITY_DURATIONS_MS,
  ACTIVITY_LABELS,
  IdleActivity,
  isWaitingState,
  motionFor,
  nextActivity,
} from "../activity";
import BeanSprite from "./BeanSprite";

interface BeanCompanionProps {
  state: BeanState;
  asset: BeanAsset;
  /** Bean without props, used while she runs somewhere without a run sheet. */
  restAsset?: BeanAsset;
  motions?: Partial<Record<BeanMotion, BeanAsset>>;
  statusText: string;
  source: string;
  session: string | null;
  preview: string | null;
  onDragStart: () => void;
}

function bubbleFor(
  state: BeanState,
  source: string,
  statusText: string,
  session: string | null,
  preview: string | null,
) {
  const snippet = preview?.replace(/\s+/g, " ").trim().slice(0, 96);
  if (statusText === "Bean is paused")
    return {
      title: "Bean is paused",
      detail: "Resume monitoring in Settings.",
    };
  if (state === "thinking")
    return {
      title: `${source === "claude_code" ? "Claude Code" : source === "cowork" ? "Cowork" : "Claude"} is working`,
      detail: snippet || "Bean is typing along…",
    };
  if (state === "happy")
    return {
      title: "Reply is ready!",
      detail: snippet || "Bean did a little jump.",
    };
  if (state === "noticed")
    return { title: "Claude needs you", detail: "There is an action waiting." };
  if (statusText === "Session failed" || statusText === "Session stopped")
    return { title: statusText, detail: "Open Claude to continue." };
  if (state === "message")
    return {
      title: "Bean noticed your message",
      detail: "Waiting for Claude’s reply…",
    };
  if (state === "sleepy")
    return {
      title: "Bean is waiting",
      detail: statusText,
    };
  return {
    title: session ? "Claude is ready" : "Bean is here",
    detail: statusText,
  };
}

export default function BeanCompanion({
  state,
  asset,
  restAsset = asset,
  motions = {},
  statusText,
  source,
  session,
  preview,
  onDragStart,
}: BeanCompanionProps) {
  const [idleActivity, setIdleActivity] = useState<IdleActivity>("breathe");
  const [previousState, setPreviousState] = useState(state);
  const [arrival, setArrival] = useState(0);
  const [settledArrival, setSettledArrival] = useState(0);
  const animationLabel: Record<BeanState, string> = {
    idle: "gentle idle breathing and tail wag",
    thinking: "typing on a tiny computer",
    happy: "jump celebration",
    noticed: "attention alert",
    message: "concerned check-in",
    sleepy: "sleeping breathing",
    soundOff: "quiet idle",
  };
  const bubble = bubbleFor(state, source, statusText, session, preview);
  const isWaiting = isWaitingState(state);

  // Bean runs over to her laptop whenever Claude starts a new piece of work.
  if (state !== previousState) {
    setPreviousState(state);
    if (state === "thinking") setArrival((count) => count + 1);
  }
  const isArriving = state === "thinking" && arrival !== settledArrival;

  useEffect(() => {
    if (arrival === 0) return;
    const timeoutId = window.setTimeout(
      () => setSettledArrival(arrival),
      1_100,
    );
    return () => window.clearTimeout(timeoutId);
  }, [arrival]);

  useEffect(() => {
    if (!isWaiting) {
      setIdleActivity("breathe");
      return;
    }

    // Alternate calm breathing with one short activity at a time.
    const resting = idleActivity === "breathe";
    const timeoutId = window.setTimeout(
      () =>
        setIdleActivity(resting ? nextActivity(state, "breathe") : "breathe"),
      resting
        ? 6_500 + Math.floor(Math.random() * 4_500)
        : ACTIVITY_DURATIONS_MS[idleActivity],
    );
    return () => window.clearTimeout(timeoutId);
  }, [isWaiting, idleActivity, state]);

  const activity: IdleActivity | "arrive" = isArriving
    ? "arrive"
    : isWaiting
      ? idleActivity
      : "breathe";
  const motion = motionFor(activity);
  const art =
    (motion && motions[motion]) || (activity === "arrive" ? restAsset : asset);
  const facesRight = typeof art !== "string" && art.facing === "right";
  const activityLabel =
    activity === "arrive"
      ? "running to the laptop"
      : activity === "breathe"
        ? animationLabel[state]
        : ACTIVITY_LABELS[activity];

  const startNativeDrag = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void onDragStart();
  };

  return (
    <section className="companion-area">
      <div className={`activity-bubble activity-${state}`} aria-live="polite">
        <strong>{bubble.title}</strong>
        <span>{bubble.detail}</span>
      </div>
      <button
        type="button"
        data-tauri-drag-region
        className={`bean-shell bean-${state}`}
        onMouseDown={startNativeDrag}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") void onDragStart();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") void onDragStart();
        }}
        aria-label={`Drag Bean — ${activityLabel}`}
      >
        <div
          className={`bean-stage idle-activity-${activity}${motion ? " is-moving" : ""}`}
          aria-hidden="true"
        >
          <div className={`bean-facing${facesRight ? " faces-right" : ""}`}>
            <BeanSprite asset={art} />
            {motion && (
              <span className="dust-pixels">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
          {activity === "boba" && (
            <span className="boba-cup">
              <i />
              <b />
              <em />
              <em />
              <em />
            </span>
          )}
          {activity === "chase" && <span className="chase-swirl" />}
          {state === "thinking" && !isArriving && (
            <span className="typing-pixels">
              <i />
              <i />
              <i />
            </span>
          )}
          {state === "happy" && (
            <span className="celebration-pixels">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          {state === "noticed" && <span className="attention-mark">!</span>}
          {state === "sleepy" && <span className="sleep-pixels">z z</span>}
        </div>
      </button>
    </section>
  );
}
