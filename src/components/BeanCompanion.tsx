import { useEffect, useState, type MouseEvent } from "react";
import { BeanState } from "../types";

interface BeanCompanionProps {
  state: BeanState;
  asset: string;
  statusText: string;
  source: string;
  session: string | null;
  preview: string | null;
  onDragStart: () => void;
}

type IdleActivity = "breathe" | "peek" | "hop" | "boba";

const IDLE_ACTIVITIES: IdleActivity[] = ["breathe", "peek", "hop", "boba"];

function bubbleFor(state: BeanState, source: string, statusText: string, session: string | null, preview: string | null) {
  const snippet = preview?.replace(/\s+/g, " ").trim().slice(0, 96);
  if (state === "thinking") return {
    title: `${source === "claude_code" ? "Claude Code" : source === "cowork" ? "Cowork" : "Claude"} is working`,
    detail: snippet ?? "Bean is typing along…",
  };
  if (state === "happy") return { title: "Reply is ready!", detail: snippet ?? "Bean did a little jump." };
  if (state === "noticed") return { title: "Claude needs you", detail: "There is an action waiting." };
  if (state === "message") return {
    title: "Bean noticed your message",
    detail: "Waiting for Claude’s reply…",
  };
  if (state === "sleepy") return {
    title: "Bean is waiting",
    detail: statusText.toLowerCase().includes("accessibility") ? statusText : "Open Claude Desktop to begin.",
  };
  return { title: session ? "Claude is ready" : "Bean is here", detail: statusText };
}

export default function BeanCompanion({ state, asset, statusText, source, session, preview, onDragStart }: BeanCompanionProps) {
  const [idleActivity, setIdleActivity] = useState<IdleActivity>("breathe");
  const animationLabel: Record<BeanState, string> = {
    idle: "gentle idle breathing and tail wag", thinking: "typing on a tiny computer", happy: "jump celebration",
    noticed: "attention alert", message: "concerned check-in", sleepy: "sleeping breathing", soundOff: "quiet idle",
  };
  const bubble = bubbleFor(state, source, statusText, session, preview);
  const isWaiting = state === "idle" || state === "sleepy" || state === "soundOff";

  useEffect(() => {
    if (!isWaiting) {
      setIdleActivity("breathe");
      return;
    }

    let timeoutId: number;
    const chooseNextActivity = () => {
      const choices = IDLE_ACTIVITIES.filter((activity) => activity !== idleActivity);
      setIdleActivity(choices[Math.floor(Math.random() * choices.length)]);
      timeoutId = window.setTimeout(chooseNextActivity, 6_500 + Math.floor(Math.random() * 4_500));
    };
    timeoutId = window.setTimeout(chooseNextActivity, 4_500);
    return () => window.clearTimeout(timeoutId);
  }, [isWaiting, idleActivity]);

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
        onPointerDown={(event) => { if (event.pointerType === "touch") void onDragStart(); }}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void onDragStart(); }}
        aria-label={`Drag Bean — ${animationLabel[state]}`}
      >
        <div className={`bean-stage idle-activity-${isWaiting ? idleActivity : "breathe"}`} aria-hidden="true">
          <img className="bean-image" src={asset} alt="" draggable={false} />
          {isWaiting && idleActivity === "boba" && <span className="boba-cup"><i /><b /><em /><em /><em /></span>}
          {state === "thinking" && <span className="typing-pixels"><i /><i /><i /></span>}
          {state === "happy" && <span className="celebration-pixels"><i /><i /><i /><i /></span>}
          {state === "noticed" && <span className="attention-mark">!</span>}
          {state === "sleepy" && <span className="sleep-pixels">z z</span>}
        </div>
      </button>
    </section>
  );
}
