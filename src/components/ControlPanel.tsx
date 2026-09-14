import { useEffect, useState } from "react";

interface ControlPanelProps {
  isPaused: boolean;
  isSoundEnabled: boolean;
  isPhotoMode: boolean;
  manualMessage: string;
  note: string;
  hasPermission: boolean;
  onPauseToggle: () => void;
  onSoundToggle: () => void;
  onRequestGrant: () => void;
  onQuit: () => void;
  onHide: () => void;
  onPhotoMode: () => void;
  onManualMessage: (next: string) => void;
  onNoteSave: (next: string) => void;
  onNoteReset: () => void;
  onAssetPackPath: (path: string) => void;
}

export default function ControlPanel({
  isPaused,
  isSoundEnabled,
  isPhotoMode,
  manualMessage,
  note,
  hasPermission,
  onPauseToggle,
  onSoundToggle,
  onRequestGrant,
  onQuit,
  onHide,
  onManualMessage,
  onNoteSave,
  onNoteReset,
  onAssetPackPath,
}: ControlPanelProps) {
  const [packPath, setPackPath] = useState("");
  const [localNote, setLocalNote] = useState(note);

  useEffect(() => {
    setLocalNote(note);
  }, [note]);

  return (
    <section className="control-panel" aria-label="Bean controls">
      <div className="controls-row">
        <button onClick={onHide} className="control-button" type="button">
          Hide
        </button>
        <button onClick={onPauseToggle} className="control-button" type="button">
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button onClick={onSoundToggle} className="control-button" type="button">
          Sound {isSoundEnabled ? "on" : "off"}
        </button>
        <button onClick={onPhotoMode} className="control-button" type="button">
          Photo mode {isPhotoMode ? "on" : "off"}
        </button>
      </div>
      <div className="controls-row">
        <button onClick={onRequestGrant} disabled={hasPermission} className="control-button" type="button">
          {hasPermission ? "Accessibility permission granted" : "Grant Accessibility"}
        </button>
        <button onClick={onQuit} className="control-button danger" type="button">
          Quit
        </button>
      </div>
      <label className="field">
        <span>Manual message</span>
        <textarea
          value={manualMessage}
          onChange={(evt) => onManualMessage(evt.target.value)}
          rows={2}
          aria-label="Manual note"
        />
      </label>
      <label className="field">
        <span>Affection note</span>
        <textarea
          value={localNote}
          onChange={(evt) => setLocalNote(evt.target.value)}
          rows={2}
          aria-label="Loving note"
        />
        <div className="controls-row">
          <button onClick={() => onNoteSave(localNote)} type="button">
          Save note
          </button>
          <button onClick={() => setLocalNote(note)} type="button">
            Restore
          </button>
          <button onClick={onNoteReset} type="button">
            Reset
          </button>
        </div>
      </label>
      <label className="field">
        <span>Asset pack path (optional)</span>
        <input
          value={packPath}
          placeholder="/path/to/bean-pack"
          onChange={(evt) => setPackPath(evt.target.value)}
          aria-label="Asset pack path"
        />
        <button onClick={() => onAssetPackPath(packPath)} type="button">
          Import pack
        </button>
      </label>
    </section>
  );
}
