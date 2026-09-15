interface ControlPanelProps {
  open: boolean;
  unavailable: boolean;
  paused: boolean;
  soundEnabled: boolean;
  showContent: boolean;
  checkingAccess: boolean;
  accessMessage: string;
  statusText: string;
  onClose: () => void;
  onPauseToggle: () => void;
  onSoundToggle: () => void;
  onShowContentChange: (value: boolean) => void;
  onCheckAccess: () => void;
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path d="M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function ControlPanel({
  open,
  unavailable,
  paused,
  soundEnabled,
  showContent,
  checkingAccess,
  accessMessage,
  statusText,
  onClose,
  onPauseToggle,
  onSoundToggle,
  onShowContentChange,
  onCheckAccess,
}: ControlPanelProps) {
  if (!open) return null;

  const monitorLabel = unavailable ? "Waiting for Claude" : paused ? "Paused" : "Watching";
  const monitorDetail = unavailable
    ? statusText
    : paused
      ? "Claude activity is temporarily paused."
      : "Bean is listening for Claude activity.";

  return (
    <aside className="control-panel" aria-label="Bean settings">
      <header className="settings-header">
        <div>
          <p>Bean controls</p>
          <h2>Settings</h2>
        </div>
        <button className="settings-close" type="button" onClick={onClose} aria-label="Close settings">
          <CloseIcon />
        </button>
      </header>

      <div className={`settings-status${unavailable ? " is-warning" : ""}`}>
        <span className="status-light" aria-hidden="true" />
        <div>
          <strong>{monitorLabel}</strong>
          <span>{accessMessage || monitorDetail}</span>
        </div>
      </div>

      <div className="settings-list">
        <button className="settings-row" type="button" onClick={onPauseToggle}>
          <span>
            <strong>{paused ? "Resume monitoring" : "Pause monitoring"}</strong>
            <small>{paused ? "Start watching Claude again" : "Temporarily stop activity updates"}</small>
          </span>
          <span className={`setting-value${paused ? " is-muted" : ""}`}>{paused ? "Paused" : "On"}</span>
        </button>
        <button className="settings-row" type="button" onClick={onSoundToggle}>
          <span>
            <strong>Completion sound</strong>
            <small>Play a gentle chime when work finishes</small>
          </span>
          <span className={`setting-value${soundEnabled ? "" : " is-muted"}`}>{soundEnabled ? "On" : "Off"}</span>
        </button>
        <label className="settings-row settings-checkbox">
          <span>
            <strong>Claude Code previews</strong>
            <small>Allow short snippets in Bean's speech bubble</small>
          </span>
          <input
            type="checkbox"
            checked={showContent}
            onChange={(event) => onShowContentChange(event.target.checked)}
            aria-label="Show Claude Code previews"
          />
          <span className="checkmark" aria-hidden="true" />
        </label>
      </div>

      <button className="accessibility-check" type="button" onClick={onCheckAccess} disabled={checkingAccess}>
        {checkingAccess ? "Checking access…" : unavailable ? "Check Accessibility" : "Refresh connection"}
      </button>
    </aside>
  );
}
