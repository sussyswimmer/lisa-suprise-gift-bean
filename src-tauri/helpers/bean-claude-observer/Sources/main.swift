import ApplicationServices
import Foundation
import AppKit

struct ClaudEvent: Codable {
  let source: String
  let session: String?
  let status: String
  let timestamp: String
}

let supportedApps = [
  "com.anthropic.claude",      // Claude Desktop (macOS)
  "com.anthropic.claude-cowork" // Cowork (if installed)
]

func now() -> String {
  let formatter = ISO8601DateFormatter()
  return formatter.string(from: Date())
}

func emit(_ source: String, _ session: String?, _ status: String) {
  let payload = ClaudEvent(source: source, session: session, status: status, timestamp: now())
  if let data = try? JSONEncoder().encode(payload),
     let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

func requiresPermission() -> Bool {
  let trusted = AXIsProcessTrustedWithOptions(nil)
  if trusted {
    return false
  }
  emit("system", nil, "unavailable")
  return true
}

func fetchSessionTitle(_ appElement: AXUIElement) -> String? {
  var focusedWindow: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow)
  if err != .success || focusedWindow == nil {
    return nil
  }

  var titleValue: CFTypeRef?
  let e = AXUIElementCopyAttributeValue(focusedWindow!, kAXTitleAttribute as CFString, &titleValue)
  if e != .success || titleValue == nil {
    return nil
  }

  return titleValue as? String
}

func inferStatus(from title: String?) -> String {
  let lowered = title?.lowercased() ?? ""
  if lowered.contains("attention") || lowered.contains("help") || lowered.contains("review") {
    return "attention_needed"
  }
  if lowered.contains("failed") || lowered.contains("error") {
    return "failed"
  }
  if lowered.contains("stopped") || lowered.contains("cancel") || lowered.contains("done") || lowered.contains("complete") {
    return "completed"
  }
  if lowered.contains("working") || lowered.contains("running") || lowered.contains("analysis") || lowered.contains("thinking") {
    return "working"
  }
  return "idle"
}

func pollAccessibility(for bundleId: String, source: String) -> Bool {
  let apps = NSWorkspace.shared.runningApplications
    .filter { $0.bundleIdentifier == bundleId }

  guard let app = apps.first else {
    return false
  }

  guard let pid = pid_t(exactly: app.processIdentifier) else {
    return false
  }

  let appElement = AXUIElementCreateApplication(pid)
  let title = fetchSessionTitle(appElement)
  let status = inferStatus(from: title)
  emit(source, title, status)
  return true
}

func usageError(_ message: String) {
  fputs("error:\(message)\n", stderr)
}

let args = CommandLine.arguments
if args.contains("--request-permission") {
  if requiresPermission() {
    exit(0)
  } else {
    emit("system", nil, "idle")
    exit(0)
  }
}

if requiresPermission() {
  // Keep helper alive; status already emitted once.
  while true {
    Thread.sleep(forTimeInterval: 2.0)
  }
}

if args.contains("--simulate") {
  var i = 0
  while true {
    emit("chat", "simulate", i % 2 == 0 ? "working" : "completed")
    i += 1
    Thread.sleep(forTimeInterval: 3.0)
  }
}

let pollInterval = 1200
while true {
  var emitted = false

  for bundleId in supportedApps {
    let source = bundleId == "com.anthropic.claude" ? "chat" : "cowork"
    if pollAccessibility(for: bundleId, source: source) {
      emitted = true
    }
  }

  if !emitted {
    emit("system", nil, "unavailable")
  }
  Thread.sleep(forTimeInterval: Double(pollInterval) / 1000.0)
}
