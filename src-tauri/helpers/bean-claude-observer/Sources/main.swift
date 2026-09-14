import ApplicationServices
import AppKit
import Foundation

struct ClaudeEvent: Codable {
  let source: String
  let session: String?
  let status: String
  let timestamp: String
  let preview: String?
}

struct SessionTracker {
  var sawWorking = false
  var quietPolls = 0
}

let supportedApps = [
  "com.anthropic.claude",
  "com.anthropic.claude-cowork",
]
var trackers = [String: SessionTracker]()
var didRequestAccessibilityPermission = false
var claudeCodeEventOffset: UInt64?
var claudeCodeHooksAvailable = false

func now() -> String {
  ISO8601DateFormatter().string(from: Date())
}

func emit(_ source: String, _ session: String?, _ status: String, _ preview: String? = nil) {
  let event = ClaudeEvent(source: source, session: session, status: status, timestamp: now(), preview: preview)
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
  let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
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
    return focusedWindow as! AXUIElement
  }

  var windowsValue: CFTypeRef?
  if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue) == .success,
     let windows = windowsValue as? [AXUIElement] {
    return windows.first
  }
  return nil
}

func visibleLabels(in root: AXUIElement, maxNodes: Int = 700) -> [String] {
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

    for attribute in attributes {
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

func conversationPreview(in root: AXUIElement, maxNodes: Int = 900) -> String? {
  var candidates = [String]()
  var queue = [root]
  var index = 0

  while index < queue.count && index < maxNodes {
    let element = queue[index]
    index += 1
    let role = stringValue(element, kAXRoleAttribute as CFString) ?? ""
    if role == (kAXStaticTextRole as String) || role == (kAXTextAreaRole as String) {
      if let text = stringValue(element, kAXValueAttribute as CFString)?
        .trimmingCharacters(in: .whitespacesAndNewlines),
         text.count >= 2,
         !text.hasPrefix("Claude can make mistakes") {
        candidates.append(text)
      }
    }

    var childrenValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
       let children = childrenValue as? [AXUIElement] {
      queue.append(contentsOf: children)
    }
  }

  guard let latest = candidates.last else { return nil }
  return String(latest.prefix(240))
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
  let eventsURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Bean/claude-code-events")
  guard let attributes = try? FileManager.default.attributesOfItem(atPath: eventsURL.path),
        let fileSize = attributes[.size] as? NSNumber else {
    return false
  }

  claudeCodeHooksAvailable = true
  let size = fileSize.uint64Value
  guard let previousOffset = claudeCodeEventOffset else {
    // Ignore events from a previous Bean run: only animate live Claude Code activity.
    claudeCodeEventOffset = size
    return true
  }

  let offset = size < previousOffset ? 0 : previousOffset
  guard size > offset, let handle = try? FileHandle(forReadingFrom: eventsURL) else {
    claudeCodeEventOffset = offset
    return true
  }
  defer { try? handle.close() }
  try? handle.seek(toOffset: offset)
  let data = (try? handle.readToEnd()) ?? Data()
  claudeCodeEventOffset = size

  guard let raw = String(data: data, encoding: .utf8) else { return true }
  for line in raw.split(whereSeparator: { $0.isNewline }).map(String.init) {
    if let eventData = line.data(using: .utf8), let event = try? JSONDecoder().decode(ClaudeEvent.self, from: eventData) {
      emit(event.source, event.session, event.status, event.preview)
    } else if ["working", "completed", "reply", "failed", "attention_needed", "stopped"].contains(line) {
      emit("claude_code", nil, line)
    }
  }
  // Prompt and reply text only needs a short-lived local handoff between the hook and Bean.
  try? Data().write(to: eventsURL, options: .atomic)
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
  guard let window = primaryWindow(appElement) else {
    resetTracker(trackerKey)
    emit(bundleID == "com.anthropic.claude-cowork" ? "cowork" : "chat", nil, "unavailable")
    return true
  }

  let title = stringValue(window, kAXTitleAttribute as CFString)
  var labels = visibleLabels(in: window)
  if let title {
    labels.append(title.lowercased())
  }
  let source = sourceFor(labels: labels)
  let status = transitionStatus(directStatus(from: labels), trackerKey: trackerKey)
  emit(source, sessionFrom(title: title), status, conversationPreview(in: window))
  return true
}

func hookPreview(from input: Data, includeContent: Bool) -> (String?, String?) {
  guard includeContent,
        let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any] else { return (nil, nil) }
  let session = object["session_id"] as? String
  for key in ["prompt", "message", "text", "content"] {
    if let value = object[key] as? String, !value.isEmpty { return (session, value) }
  }
  return (session, nil)
}

func appendClaudeCodeHook(status: String, includeContent: Bool) {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  let (session, preview) = hookPreview(from: input, includeContent: includeContent)
  let event = ClaudeEvent(source: "claude_code", session: session, status: status, timestamp: now(), preview: preview)
  guard let encoded = try? JSONEncoder().encode(event) else { return }
  let eventsURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Bean/claude-code-events")
  try? FileManager.default.createDirectory(at: eventsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  if !FileManager.default.fileExists(atPath: eventsURL.path) { FileManager.default.createFile(atPath: eventsURL.path, contents: nil) }
  if let handle = try? FileHandle(forWritingTo: eventsURL) {
    defer { try? handle.close() }
    try? handle.seekToEnd()
    try? handle.write(encoded + Data("\n".utf8))
  }
}
let args = CommandLine.arguments
if let hookIndex = args.firstIndex(of: "--claude-code-hook"), args.indices.contains(hookIndex + 1) {
  appendClaudeCodeHook(status: args[hookIndex + 1], includeContent: args.contains("content"))
  exit(0)
}
if args.contains("--request-permission") {
  emit("system", nil, requestAccessibilityPermission() ? "idle" : "unavailable")
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

while true {
  let hasClaudeCodeHooks = pollClaudeCodeHooks() || claudeCodeHooksAvailable
  guard isAccessibilityTrusted() else {
    if !didRequestAccessibilityPermission {
      _ = requestAccessibilityPermission()
      didRequestAccessibilityPermission = true
    }
    emit("system", nil, "unavailable")
    Thread.sleep(forTimeInterval: 1.2)
    continue
  }

  var observedApp = false
  for bundleID in supportedApps {
    observedApp = pollAccessibility(for: bundleID) || observedApp
  }
  if !observedApp && !hasClaudeCodeHooks {
    emit("system", nil, "unavailable")
  }
  Thread.sleep(forTimeInterval: 1.2)
}
