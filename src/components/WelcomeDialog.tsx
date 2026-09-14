interface WelcomeDialogProps {
  onConnect: () => void;
}

export default function WelcomeDialog({ onConnect }: WelcomeDialogProps) {
  return (
    <main className="welcome-dialog">
      <span className="welcome-pixel" aria-hidden="true">🐾</span>
      <h1>Use your Claude subscription</h1>
      <p>Bean uses the Claude subscription you are already signed into. It connects to Claude Code with local status hooks and can watch Claude Desktop when macOS allows it.</p>
      <p>There is nothing to log into here. Bean never asks for or reads passwords, API keys, or chat text.</p>
      <button type="button" onClick={onConnect}>Connect Bean to Claude</button>
      <small>Bean adds only local Claude Code status hooks, then asks macOS for optional Desktop Accessibility.</small>
    </main>
  );
}
