interface WelcomeDialogProps {
  onConnect: () => void;
}

export default function WelcomeDialog({ onConnect }: WelcomeDialogProps) {
  return (
    <main className="welcome-dialog">
      <span className="welcome-pixel" aria-hidden="true">🐾</span>
      <h1>Use your Claude subscription</h1>
      <p>Bean watches the Claude Desktop app you are already signed into.</p>
      <p>There is nothing to log into here. Bean never asks for or reads passwords, API keys, or chats.</p>
      <button type="button" onClick={onConnect}>Connect Bean to Claude</button>
      <small>Next, allow Accessibility in macOS so Bean can notice app activity.</small>
    </main>
  );
}
