import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ActivityArt, BeanAsset, BeanMotion, BeanState } from "../types";
import {
  ACTIVITY_LABELS,
  ActivityFrequency,
  activitiesFor,
  activityDurationMs,
  availableActivities,
  IdleActivity,
  isWaitingState,
  motionFor,
  nextActivity,
  restDelayMs,
} from "../activity";
import BeanSprite from "./BeanSprite";

interface BeanCompanionProps {
  state: BeanState;
  asset: BeanAsset;
  /** Bean without props, used while she runs somewhere without a run sheet. */
  restAsset?: BeanAsset;
  motions?: Partial<Record<BeanMotion, BeanAsset>>;
  /** Sprite sheets for idle activities, such as sipping boba. */
  activities?: ActivityArt;
  /** Activities switched off in Settings. */
  disabledActivities?: string[];
  activityFrequency?: ActivityFrequency;
  showBubble?: boolean;
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
      detail: "Resume from the paw icon in the menu bar.",
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
  activities = {},
  disabledActivities = [],
  activityFrequency = "normal",
  showBubble = true,
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

  // Read the latest state inside the timer without restarting it: Claude can
  // flicker between idle and unavailable every second, which kept resetting
  // the countdown so an activity never ended.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // Settings are read the same way so changing them never resets the timer.
  const activityOptions = {
    available: availableActivities(activities),
    disabled: disabledActivities,
  };
  const optionsRef = useRef({ activityOptions, activities, activityFrequency });
  useEffect(() => {
    optionsRef.current = { activityOptions, activities, activityFrequency };
  });

  useEffect(() => {
    if (!isWaiting) {
      setIdleActivity("breathe");
      return;
    }

    // Alternate calm breathing with one short activity at a time.
    const resting = idleActivity === "breathe";
    const options = optionsRef.current;
    const timeoutId = window.setTimeout(
      () =>
        setIdleActivity(
          resting
            ? nextActivity(
                stateRef.current,
                "breathe",
                Math.random,
                optionsRef.current.activityOptions,
              )
            : "breathe",
        ),
      resting
        ? restDelayMs(options.activityFrequency)
        : activityDurationMs(idleActivity, options.activities[idleActivity]),
    );
    return () => window.clearTimeout(timeoutId);
  }, [isWaiting, idleActivity]);

  // A drowsy Bean drops zoomies at once instead of finishing them.
  const activity: IdleActivity | "arrive" = isArriving
    ? "arrive"
    : isWaiting && activitiesFor(state, activityOptions).includes(idleActivity)
      ? idleActivity
      : "breathe";
  const motion = motionFor(activity);
  const activitySheet =
    activity !== "arrive" && activity !== "breathe" && !motion
      ? activities[activity]
      : undefined;
  const art =
    (motion && motions[motion]) ||
    activitySheet ||
    (activity === "arrive" ? restAsset : asset);
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
      {showBubble && (
        <div className={`activity-bubble activity-${state}`} aria-live="polite">
          <strong>{bubble.title}</strong>
          <span>{bubble.detail}</span>
        </div>
      )}
      <button
        type="button"
        data-tauri-drag-region
        className={`bean-shell bean-${state}${typeof art === "string" ? "" : " has-sprite"}`}
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
          className={`bean-stage idle-activity-${activitySheet ? "sheet" : activity}${motion ? " is-moving" : ""}`}
          data-activity={activity}
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
          {activity === "boba" && !activitySheet && (
            <span className="boba-cup">
              <i />
              <b />
              <em />
              <em />
              <em />
            </span>
          )}
          {activity === "chase" && !activitySheet && (
            <span className="chase-swirl" />
          )}
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
