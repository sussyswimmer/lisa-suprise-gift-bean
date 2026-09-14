interface WelcomeDialogProps {
  showContent: boolean;
  connecting: boolean;
  connectionError: string;
  onShowContentChange: (value: boolean) => void;
  onConnect: () => void;
}

export default function WelcomeDialog({ showContent, connecting, connectionError, onShowContentChange, onConnect }: WelcomeDialogProps) {
  return (
    <main className="welcome-dialog">
      <span className="welcome-pixel" aria-hidden="true">🐾</span>
      <h1>Connect Bean to Claude</h1>
      <p>Use the Claude subscription already signed in on this Mac. Bean never asks for a password or API key.</p>
      <label className="content-opt-in">
        <input type="checkbox" checked={showContent} onChange={(event) => onShowContentChange(event.target.checked)} />
        <span>Show my Claude Code prompts and replies in Bean’s bubbles.</span>
      </label>
      <p className="welcome-detail">When enabled, snippets stay on this Mac and are shown only while Bean is open.</p>
      <button type="button" onClick={onConnect} disabled={connecting}>{connecting ? "Connecting…" : "Connect"}</button>
      {connectionError && <p className="connection-error" role="alert">Could not start Bean’s Mac helper: {connectionError}</p>}
      <small>Bean adds local Claude Code hooks, then asks macOS for optional Desktop Accessibility.</small>
    </main>
  );
}
