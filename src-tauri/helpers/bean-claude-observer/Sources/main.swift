import ApplicationServices
import AppKit
import Foundation
import Darwin

struct ClaudeEvent: Codable {
  let source: String
  let session: String?
  let status: String
  let timestamp: String
  let preview: String?
  let reason: String?
}

struct SessionTracker {
  var sawWorking = false
  var quietPolls = 0
  var composerFingerprint: Int?
  var lastComposerChange: Date?
}

let supportedApps = [
  // Current Claude Desktop bundle identifier. Chat, Cowork, and Code all live
  // inside this host application and are distinguished from Accessibility labels.
  "com.anthropic.claudefordesktop",
  // Keep the older identifiers for users who have not updated Claude yet.
  "com.anthropic.claude",
  "com.anthropic.claude-cowork",
]
var trackers = [String: SessionTracker]()
var claudeCodeEventOffset: UInt64 = 0
var claudeCodeHooksAvailable = false
var claudeCodeWorkingSessions = Set<String>()
var lastClaudeCodeEventAt: Date?
var claudeCodeEventsURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/Bean/claude-code-events")

func now() -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date())
}

func emit(_ source: String, _ session: String?, _ status: String, _ preview: String? = nil, reason: String? = nil) {
  let event = ClaudeEvent(source: source, session: session, status: status, timestamp: now(), preview: preview, reason: reason)
  guard let data = try? JSONEncoder().encode(event), let line = String(data: data, encoding: .utf8) else {
    return
  }
  print(line)
  fflush(stdout)
}

func isAccessibilityTrusted() -> Bool {
  AXIsProcessTrustedWithOptions(nil)
}

func requestAccessibilityPermission() -> Bool {
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  return AXIsProcessTrustedWithOptions(options)
}

func stringValue(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
    return nil
  }
  return value as? String
}

func primaryWindow(_ appElement: AXUIElement) -> AXUIElement? {
  var focusedWindow: CFTypeRef?
  if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow) == .success,
     let focusedWindow {
    return (focusedWindow as! AXUIElement)
  }

  var windowsValue: CFTypeRef?
  if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue) == .success,
     let windows = windowsValue as? [AXUIElement] {
    return windows.first
  }
  return nil
}

func visibleLabels(in root: AXUIElement, maxNodes: Int = 180) -> [String] {
  let attributes: [CFString] = [
    kAXRoleAttribute as CFString,
    kAXSubroleAttribute as CFString,
    kAXTitleAttribute as CFString,
    kAXDescriptionAttribute as CFString,
    kAXValueAttribute as CFString,
    "AXIdentifier" as CFString,
  ]
  var labels = [String]()
  var queue = [root]
  var index = 0

  while index < queue.count && index < maxNodes {
    let element = queue[index]
    index += 1

    let role = stringValue(element, kAXRoleAttribute as CFString) ?? ""
    let isContent = [kAXStaticTextRole as String, kAXTextAreaRole as String, kAXTextFieldRole as String].contains(role)
    for attribute in attributes where !isContent || attribute == kAXRoleAttribute as CFString {
      if let value = stringValue(element, attribute)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
        labels.append(value.lowercased())
      }
    }

    var childrenValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
       let children = childrenValue as? [AXUIElement] {
      queue.append(contentsOf: children)
    }
  }

  return Array(Set(labels))
}

func sourceFor(labels: [String]) -> String {
  labels.contains(where: { $0.contains("cowork") }) ? "cowork" : "chat"
}

func sessionFrom(title: String?) -> String? {
  guard let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
    return nil
  }
  let genericTitles = ["claude", "claude desktop", "anthropic claude"]
  return genericTitles.contains(title.lowercased()) ? nil : title
}

func directStatus(from labels: [String]) -> String {
  let joined = labels.joined(separator: " ")
  let hasExactStop = labels.contains { ["stop", "stop response", "stop generating", "stop responding"].contains($0) }
  let workSignals = [
    "stop generating", "stop responding", "stop response", "cancel response", "cancel generation", "cancel task",
    "generating response", "thinking", "working",
  ]
  if hasExactStop || workSignals.contains(where: { joined.contains($0) }) {
    return "working"
  }
  if ["needs attention", "attention required", "approve", "review required"].contains(where: { joined.contains($0) }) {
    return "attention_needed"
  }
  if ["generation failed", "response failed", "something went wrong", "error occurred"].contains(where: { joined.contains($0) }) {
    return "failed"
  }
  if ["generation stopped", "response stopped", "cancelled"].contains(where: { joined.contains($0) }) {
    return "stopped"
  }
  return "idle"
}

func focusedComposerFingerprint(in appElement: AXUIElement) -> Int? {
  var focusedValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
        let focusedValue else {
    return nil
  }

  let focusedElement = focusedValue as! AXUIElement
  let role = stringValue(focusedElement, kAXRoleAttribute as CFString) ?? ""
  guard role == (kAXTextAreaRole as String) || role == (kAXTextFieldRole as String),
        let text = stringValue(focusedElement, kAXValueAttribute as CFString)?
          .trimmingCharacters(in: .whitespacesAndNewlines),
        !text.isEmpty else {
    return nil
  }

  // Bean only needs to know that the composer changed. Keep a small local
  // fingerprint rather than carrying the typed text into observer state.
  return text.utf8.reduce(5381) { ($0 &* 33) &+ Int($1) }
}

func composerIsActive(in appElement: AXUIElement, trackerKey: String) -> Bool {
  var tracker = trackers[trackerKey] ?? SessionTracker()
  defer { trackers[trackerKey] = tracker }

  guard let fingerprint = focusedComposerFingerprint(in: appElement) else {
    tracker.composerFingerprint = nil
    return false
  }

  if tracker.composerFingerprint != fingerprint {
    tracker.composerFingerprint = fingerprint
    tracker.lastComposerChange = Date()
    return true
  }

  guard let lastChange = tracker.lastComposerChange else { return false }
  return Date().timeIntervalSince(lastChange) < 3
}

func transitionStatus(_ observed: String, trackerKey: String) -> String {
  var tracker = trackers[trackerKey] ?? SessionTracker()
  defer { trackers[trackerKey] = tracker }

  if observed == "working" {
    tracker.sawWorking = true
    tracker.quietPolls = 0
    return "working"
  }

  if observed != "idle" {
    tracker.sawWorking = false
    tracker.quietPolls = 0
    return observed
  }

  guard tracker.sawWorking else {
    return "idle"
  }

  tracker.quietPolls += 1
  if tracker.quietPolls >= 2 {
    tracker.sawWorking = false
    tracker.quietPolls = 0
    return "completed"
  }
  return "working"
}

func resetTracker(_ key: String) {
  trackers[key] = SessionTracker()
}

func pollClaudeCodeHooks() -> Bool {
  let eventsURL = claudeCodeEventsURL
  guard let attributes = try? FileManager.default.attributesOfItem(atPath: eventsURL.path),
        let fileSize = attributes[.size] as? NSNumber else {
    return false
  }

  claudeCodeHooksAvailable = true
  let size = fileSize.uint64Value
  let offset = size < claudeCodeEventOffset ? 0 : claudeCodeEventOffset
  guard size > offset, let handle = try? FileHandle(forUpdating: eventsURL) else {
    claudeCodeEventOffset = offset
    return true
  }
  defer { try? handle.close() }
  guard flock(handle.fileDescriptor, LOCK_EX) == 0 else { return true }
  defer { flock(handle.fileDescriptor, LOCK_UN) }
  try? handle.seek(toOffset: offset)
  let data = (try? handle.readToEnd()) ?? Data()
  claudeCodeEventOffset = size

  guard let raw = String(data: data, encoding: .utf8) else { return true }
  for line in raw.split(whereSeparator: { $0.isNewline }).map(String.init) {
    if let eventData = line.data(using: .utf8), let event = try? JSONDecoder().decode(ClaudeEvent.self, from: eventData) {
      let session = event.session ?? "unknown"
      if event.status == "working" { claudeCodeWorkingSessions.insert(session) }
      if ["completed", "failed", "stopped"].contains(event.status) { claudeCodeWorkingSessions.remove(session) }
      lastClaudeCodeEventAt = Date()
      emit(event.source, event.session, event.status, event.preview)
    } else if ["working", "completed", "reply", "failed", "attention_needed", "stopped"].contains(line) {
      emit("claude_code", nil, line)
    }
  }
  // Prompt and reply text only needs a short-lived local handoff between the hook and Bean.
  try? handle.truncate(atOffset: 0)
  claudeCodeEventOffset = 0
  return true
}
func pollAccessibility(for bundleID: String) -> Bool {
  let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
  guard let app = apps.first else {
    return false
  }

  let trackerKey = bundleID
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  // Electron does not always expose Chromium's content tree until assistive
  // software explicitly enables it. This only changes Claude's AX support.
  _ = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  guard let window = primaryWindow(appElement) else {
    resetTracker(trackerKey)
    emit(bundleID == "com.anthropic.claude-cowork" ? "cowork" : "chat", nil, "unavailable", reason: "window_unavailable")
    return true
  }

  let title = stringValue(window, kAXTitleAttribute as CFString)
  let labels = visibleLabels(in: window)

  guard labels.contains("axwebarea") else {
    resetTracker(trackerKey)
    emit("chat", sessionFrom(title: title), "unavailable", reason: "interface_unavailable")
    return true
  }
  let source = sourceFor(labels: labels)
  let observedStatus = directStatus(from: labels)
  let transitioned = transitionStatus(observedStatus, trackerKey: trackerKey)
  let status = transitioned == "idle" && composerIsActive(in: appElement, trackerKey: trackerKey)
    ? "message" : transitioned
  // Desktop monitoring remains status-only; previews are opt-in Code hooks.
  emit(source, sessionFrom(title: title), status)
  return true
}

func hookPreview(from input: Data, includeContent: Bool) -> (String?, String?) {
  guard let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any] else { return (nil, nil) }
  let session = object["session_id"] as? String
  guard includeContent else { return (session, nil) }
  for key in ["prompt", "last_assistant_message", "delta", "message", "text", "content"] {
    if let value = object[key] as? String, !value.isEmpty { return (session, String(value.prefix(240))) }
  }
  return (session, nil)
}

func appendClaudeCodeHook(status: String, includeContent: Bool) {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  let (session, preview) = hookPreview(from: input, includeContent: includeContent)
  let event = ClaudeEvent(source: "claude_code", session: session, status: status, timestamp: now(), preview: preview, reason: nil)
  guard let encoded = try? JSONEncoder().encode(event) else { return }
  let eventsURL = claudeCodeEventsURL
  try? FileManager.default.createDirectory(at: eventsURL.deletingLastPathComponent(), withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700])
  // O_CREAT without O_TRUNC avoids concurrent first writers erasing one another.
  let descriptor = open(eventsURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
  guard descriptor >= 0 else { return }
  let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  defer { try? handle.close() }
  guard flock(descriptor, LOCK_EX) == 0 else { return }
  defer { flock(descriptor, LOCK_UN) }
  try? handle.write(contentsOf: encoded + Data("\n".utf8))

}
let args = CommandLine.arguments
if args.contains("--self-test") {
  let testDir = FileManager.default.temporaryDirectory.appendingPathComponent("bean-hook-test-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: testDir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: testDir) }
  claudeCodeEventsURL = testDir.appendingPathComponent("events")
  precondition(transitionStatus("working", trackerKey: "test") == "working")
  precondition(transitionStatus("idle", trackerKey: "test") == "working")
  precondition(transitionStatus("idle", trackerKey: "test") == "completed")
  precondition(transitionStatus("idle", trackerKey: "test") == "idle")
  precondition(!pollClaudeCodeHooks(), "No queue should mean no event")
  let prompt = ClaudeEvent(source: "claude_code", session: "test", status: "working", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(prompt) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  precondition(pollClaudeCodeHooks(), "The first live queue must be read")
  precondition(claudeCodeWorkingSessions.contains("test"), "The first prompt must not be discarded")
  let stop = ClaudeEvent(source: "claude_code", session: "test", status: "completed", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(stop) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  _ = pollClaudeCodeHooks()
  precondition(claudeCodeWorkingSessions.isEmpty, "Stop must clear the working session")
  let input = Data(#"{"session_id":"test","last_assistant_message":"Final reply"}"#.utf8)
  precondition(hookPreview(from: input, includeContent: true).1 == "Final reply", "Stop must read the documented reply field")
  precondition(hookPreview(from: input, includeContent: false).0 == "test", "Status-only hooks must retain session identity")
  precondition(hookPreview(from: input, includeContent: false).1 == nil, "Status-only hooks must not expose text")
  print("Bean helper self-test passed")
  exit(0)
}
if let hookIndex = args.firstIndex(of: "--claude-code-hook"), args.indices.contains(hookIndex + 1) {
  appendClaudeCodeHook(status: args[hookIndex + 1], includeContent: args.contains("content"))
  exit(0)
}
if args.contains("--request-permission") {
  let granted = requestAccessibilityPermission()
  emit("system", nil, granted ? "idle" : "unavailable", reason: granted ? nil : "permission_denied")
  exit(0)
}
if args.contains("--connection-status") {
  guard isAccessibilityTrusted() else {
    emit("system", nil, "unavailable", reason: "permission_denied")
    exit(0)
  }
  var found = false
  for bundleID in supportedApps {
    found = pollAccessibility(for: bundleID) || found
  }
  if !found { emit("system", nil, "unavailable", reason: "claude_not_running") }
  exit(0)
}

if args.contains("--simulate") {
  var index = 0
  while true {
    emit("chat", "simulate", index.isMultiple(of: 2) ? "working" : "completed")
    index += 1
    Thread.sleep(forTimeInterval: 3)
  }
}

// Ignore events left over before this observer starts, without discarding the
// first live prompt when the events file is created later.
let existingEventsPath = claudeCodeEventsURL.path
if let attributes = try? FileManager.default.attributesOfItem(atPath: existingEventsPath),
   let size = attributes[.size] as? NSNumber {
  claudeCodeEventOffset = size.uint64Value
}

while true {
  let hasClaudeCodeHooks = pollClaudeCodeHooks() || claudeCodeHooksAvailable
  // Desktop permission or idle polling must not erase live Claude Code work.
  if !claudeCodeWorkingSessions.isEmpty || (lastClaudeCodeEventAt.map { Date().timeIntervalSince($0) < 4 } ?? false) {
    Thread.sleep(forTimeInterval: 1.2)
    continue
  }
  guard isAccessibilityTrusted() else {
    emit("system", nil, "unavailable", reason: "permission_denied")
    Thread.sleep(forTimeInterval: 1.2)
    continue
  }

  var observedApp = false
  for bundleID in supportedApps {
    observedApp = pollAccessibility(for: bundleID) || observedApp
  }
  if !observedApp && !hasClaudeCodeHooks {
    trackers.removeAll()
    emit("system", nil, "unavailable", reason: "claude_not_running")
  }
  Thread.sleep(forTimeInterval: 1.2)
}
