import { BeanAssetState, BeanState } from "../types";

interface BeanCompanionProps {
  state: BeanState;
  assets: BeanAssetState;
  statusText: string;
  source: string;
  onDragStart: () => void;
}

export default function BeanCompanion({
  state,
  assets,
  statusText,
  source,
  onDragStart,
}: BeanCompanionProps) {
  const assetKey = (() => {
    if (state === "thinking") return "thinking";
    if (state === "message") return "message";
    if (state === "happy") return "happy";
    if (state === "sleepy") return "sleepy";
    if (state === "soundOff") return "soundOff";
    if (state === "noticed") return "noticed";
    return "idle";
  })();

  const animationLabel: Record<BeanState, string> = {
    idle: "gentle idle breathing and tail wag",
    thinking: "typing on a tiny computer",
    happy: "jump celebration",
    noticed: "attention alert",
    message: "concerned check-in",
    sleepy: "sleeping breathing",
    soundOff: "quiet idle",
  };

  return (
    <button
      type="button"
      className={`bean-shell bean-${state}`}
      onMouseDown={onDragStart}
      onKeyDown={(evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          onDragStart();
        }
      }}
      aria-label={`Move Bean — ${animationLabel[state]}`}
    >
      <div className="status-bubble" aria-live="polite">
        <span className="status-tag">{source}</span>
        <span className="status-text">{statusText}</span>
      </div>
      <div className="bean-stage" aria-hidden="true">
        <img className="bean-image" src={assets[assetKey as keyof BeanAssetState]} alt="" draggable={false} />
        {state === "thinking" && <span className="typing-pixels"><i /><i /><i /></span>}
        {state === "happy" && <span className="celebration-pixels"><i /><i /><i /><i /></span>}
        {state === "noticed" && <span className="attention-mark">!</span>}
        {state === "sleepy" && <span className="sleep-pixels">z z</span>}
      </div>
    </button>
  );
}
