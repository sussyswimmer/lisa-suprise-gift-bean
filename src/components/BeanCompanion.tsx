import type { MouseEvent } from "react";
import { BeanState } from "../types";

interface BeanCompanionProps {
  state: BeanState;
  asset: string;
  statusText: string;
  source: string;
  session: string | null;
  onDragStart: () => void;
}

function bubbleFor(state: BeanState, source: string, statusText: string, session: string | null) {
  if (state === "thinking") return { title: `${source === "cowork" ? "Cowork" : "Claude"} is working`, detail: "Bean is typing along…" };
  if (state === "happy") return { title: "Reply is ready!", detail: "Bean did a little jump." };
  if (state === "noticed") return { title: "Claude needs you", detail: "There is an action waiting." };
  if (state === "message") return { title: "Claude paused", detail: statusText };
  if (state === "sleepy") return { title: "Bean is waiting", detail: "Open Claude Desktop to begin." };
  return { title: session ? "Claude is ready" : "Bean is here", detail: statusText };
}

export default function BeanCompanion({ state, asset, statusText, source, session, onDragStart }: BeanCompanionProps) {
  const animationLabel: Record<BeanState, string> = {
    idle: "gentle idle breathing and tail wag", thinking: "typing on a tiny computer", happy: "jump celebration",
    noticed: "attention alert", message: "concerned check-in", sleepy: "sleeping breathing", soundOff: "quiet idle",
  };
  const bubble = bubbleFor(state, source, statusText, session);

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
        <div className="bean-stage" aria-hidden="true">
          <img className="bean-image" src={asset} alt="" draggable={false} />
          {state === "thinking" && <span className="typing-pixels"><i /><i /><i /></span>}
          {state === "happy" && <span className="celebration-pixels"><i /><i /><i /><i /></span>}
          {state === "noticed" && <span className="attention-mark">!</span>}
          {state === "sleepy" && <span className="sleep-pixels">z z</span>}
        </div>
      </button>
    </section>
  );
}
