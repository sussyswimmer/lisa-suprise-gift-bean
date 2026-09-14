import { BeanAssetState } from "../types";

interface BeanCompanionProps {
  state: string;
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
      aria-label="Move Bean"
    >
      <div className="status-bubble" aria-live="polite">
        <span className="status-tag">{source}</span>
        <span className="status-text">{statusText}</span>
      </div>
      <img className="bean-image" src={assets[assetKey as keyof BeanAssetState]} alt="Bean companion" draggable={false} />
    </button>
  );
}
