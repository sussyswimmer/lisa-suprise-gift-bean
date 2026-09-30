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
  var inconclusivePolls = 0
  var composerFingerprint: Int?
  var lastComposerChange: Date?
}

struct DesktopObservation {
  let source: String
  let session: String?
  let status: String
  let reason: String?
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
// Claude Code sessions that are working or waiting on the user, keyed by their
// last hook event. Interrupting Claude Code with Esc fires no Stop hook, so
// entries expire instead of hiding Claude Desktop activity forever.
var claudeCodeActiveSessions = [String: Date]()
let claudeCodeSessionTimeout: TimeInterval = 30 * 60
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

func emit(_ observation: DesktopObservation) {
  emit(observation.source, observation.session, observation.status, reason: observation.reason)
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

func elementValue(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let object = value, CFGetTypeID(object) == AXUIElementGetTypeID() else {
    return nil
  }
  return (object as! AXUIElement)
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
  for attribute in [kAXChildrenAttribute as CFString, "AXContents" as CFString] {
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
       let children = value as? [AXUIElement], !children.isEmpty { return children }
  }
  return []
}

func candidateWindows(_ appElement: AXUIElement) -> [AXUIElement] {
  var result = [AXUIElement]()
  for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
    if let window = elementValue(appElement, attribute as CFString),
       !result.contains(where: { CFEqual($0, window) }) {
      result.append(window)
    }
  }
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value) == .success,
     let windows = value as? [AXUIElement] {
    for window in windows where !result.contains(where: { CFEqual($0, window) }) { result.append(window) }
  }
  return result
}

let textRoles: Set<String> = ["AXTextArea", "AXTextField"]
// Text nodes are leaves for status monitoring, even if they expose spans.
let leafRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField"]
let controlRoles: Set<String> = [
  "AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXTab", "AXProgressIndicator", "AXPopUpButton", "AXMenuButton",
]

func isSendLabel(_ label: String) -> Bool {
  label == "send" || label.hasPrefix("send ") || ["submit message", "start task"].contains(label)
}

func isStopLabel(_ label: String) -> Bool {
  // Dictation and sharing controls also say "Stop"; they are not Claude replying.
  guard !["record", "dictat", "voice", "listen", "shar", "audio"].contains(where: { label.contains($0) }) else {
    return false
  }
  return label == "stop" || label.hasPrefix("stop ") || label == "interrupt"
    || ["cancel response", "cancel generation", "cancel task", "generating response"].contains(where: { label.hasPrefix($0) })
}

func isAttentionLabel(_ label: String) -> Bool {
  ["approve", "allow", "deny", "always allow", "allow always"].contains(label)
    || label.hasPrefix("approve ")
    || ["allow once", "allow for this", "needs attention", "attention required", "review required", "requires approval",
        "needs your approval", "waiting for approval", "permission required"].contains(where: { label.contains($0) })
}

func isFailureLabel(_ label: String) -> Bool {
  ["generation failed", "response failed", "something went wrong", "error occurred", "message failed", "failed to send"]
    .contains(where: { label.contains($0) })
}

func isStoppedLabel(_ label: String) -> Bool {
  ["generation stopped", "response stopped", "response was interrupted", "response interrupted"]
    .contains(where: { label.contains($0) })
}

struct NodeInfo {
  var role: String
  var labels = [String]()
  var selected = false
}

struct InterfaceSnapshot {
  var labels = [String]()
  var selectedLabels = [String]()
  var readable = false
  var incomplete = false
  var hasComposer = false
  var hasSendControl = false
  var hasStopControl = false
  var visited = 0

  // Claude shows Send or Stop beside its composer, so finding either means the
  // scan reached the part of the window that carries the reply status.
  var hasComposerControls: Bool { hasSendControl || hasStopControl }

  mutating func record(_ info: NodeInfo) {
    visited += 1
    hasComposer = hasComposer || textRoles.contains(info.role)
    readable = readable || info.role == "AXWebArea"
    labels.append(contentsOf: info.labels)
    if info.selected { selectedLabels.append(contentsOf: info.labels) }
    hasSendControl = hasSendControl || info.labels.contains(where: isSendLabel)
    hasStopControl = hasStopControl || info.labels.contains(where: isStopLabel)
  }

  mutating func merge(_ other: InterfaceSnapshot) {
    labels.append(contentsOf: other.labels)
    selectedLabels.append(contentsOf: other.selectedLabels)
    readable = readable || other.readable
    hasComposer = hasComposer || other.hasComposer
    hasSendControl = hasSendControl || other.hasSendControl
    hasStopControl = hasStopControl || other.hasStopControl
    visited += other.visited
  }

  mutating func finish() {
    readable = readable || (hasComposer && hasComposerControls)
  }
}

// A long conversation or sidebar can hold thousands of nodes, while Claude's
// composer, Send/Stop button, and newest message sit at the end of the window.
// Walk depth-first from the last child so those are reached before the budget
// runs out, then stop shortly after the composer controls are found.
func scanTree<Node>(root: Node, maxNodes: Int = 3_000, extraNodesAfterControls: Int = 400,
                    children: (Node) -> [Node], inspect: (Node) -> NodeInfo,
                    shouldContinue: () -> Bool = { true }) -> InterfaceSnapshot {
  var snapshot = InterfaceSnapshot()
  var stack = [root]
  var controlsFoundAt: Int?
  while let node = stack.popLast() {
    let info = inspect(node)
    snapshot.record(info)
    if controlsFoundAt == nil && snapshot.hasComposerControls { controlsFoundAt = snapshot.visited }
    if !leafRoles.contains(info.role) { stack.append(contentsOf: children(node)) }
    if snapshot.visited >= maxNodes || !shouldContinue() { break }
    if let found = controlsFoundAt, snapshot.visited >= found + extraNodesAfterControls { break }
  }
  snapshot.incomplete = !stack.isEmpty && !snapshot.hasComposerControls
  snapshot.finish()
  return snapshot
}

// When the whole-window scan is inconclusive, start at the focused composer
// and widen one ancestor at a time until the Send/Stop control beside it shows up.
func scanAround<Node>(start: Node, maxLevels: Int = 8, maxNodes: Int = 600,
                      parent: (Node) -> Node?, children: (Node) -> [Node], inspect: (Node) -> NodeInfo,
                      same: (Node, Node) -> Bool, shouldContinue: () -> Bool = { true }) -> InterfaceSnapshot {
  var snapshot = InterfaceSnapshot()
  snapshot.record(inspect(start))
  var current = start
  for _ in 0..<maxLevels {
    guard !snapshot.hasComposerControls, snapshot.visited < maxNodes, shouldContinue(),
          let next = parent(current) else { break }
    snapshot.record(inspect(next))
    for sibling in children(next).reversed() where !same(sibling, current) {
      let budget = maxNodes - snapshot.visited
      guard budget > 0, !snapshot.hasComposerControls else { break }
      snapshot.merge(scanTree(root: sibling, maxNodes: budget, extraNodesAfterControls: 40,
                              children: children, inspect: inspect, shouldContinue: shouldContinue))
    }
    current = next
  }
  snapshot.incomplete = !snapshot.hasComposerControls
  snapshot.finish()
  return snapshot
}

func isSelected(_ element: AXUIElement, role: String) -> Bool {
  guard ["AXRadioButton", "AXTab", "AXCheckBox"].contains(role) else { return false }
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, kAXSelectedAttribute as CFString, &value) == .success,
     let selected = value as? Bool, selected {
    return true
  }
  value = nil
  // Chromium reports a selected tab or pressed toggle as the value 1.
  guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
        let number = value as? NSNumber else {
    return false
  }
  return number.intValue == 1
}

// Read roles and control labels only; message and composer values are never copied.
func inspectElement(_ element: AXUIElement) -> NodeInfo {
  let role = stringValue(element, kAXRoleAttribute as CFString) ?? ""
  guard controlRoles.contains(role) else { return NodeInfo(role: role) }
  let attributes = [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString, "AXIdentifier" as CFString]
  let labels = attributes.compactMap { stringValue(element, $0)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
  return NodeInfo(role: role, labels: labels.filter { !$0.isEmpty }, selected: isSelected(element, role: role))
}

func visibleInterface(in root: AXUIElement, shouldContinue: () -> Bool) -> InterfaceSnapshot {
  scanTree(root: root, children: childElements, inspect: inspectElement, shouldContinue: shouldContinue)
}

func composerSurroundings(in appElement: AXUIElement) -> InterfaceSnapshot? {
  guard let focused = elementValue(appElement, kAXFocusedUIElementAttribute as CFString),
        textRoles.contains(stringValue(focused, kAXRoleAttribute as CFString) ?? "") else {
    return nil
  }
  let deadline = Date().addingTimeInterval(0.6)
  return scanAround(start: focused, parent: { elementValue($0, kAXParentAttribute as CFString) },
                    children: childElements, inspect: inspectElement, same: { CFEqual($0, $1) },
                    shouldContinue: { Date() < deadline })
}

func sourceFor(selectedLabels: [String], fallback: String) -> String {
  // Claude Desktop always shows its Chat/Cowork/Code switcher, so only the
  // selected mode says which one is active.
  if selectedLabels.contains(where: { $0 == "cowork" || $0.hasPrefix("cowork ") }) { return "cowork" }
  if selectedLabels.contains(where: { $0 == "chat" || $0.hasPrefix("chat ") }) { return "chat" }
  return fallback
}

func sessionFrom(title: String?) -> String? {
  guard let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
    return nil
  }
  let genericTitles = ["claude", "claude desktop", "anthropic claude"]
  return genericTitles.contains(title.lowercased()) ? nil : title
}

// Returns nil when the scan never reached the composer, so a partial read
// cannot be mistaken for Claude finishing its reply.
func directStatus(from snapshot: InterfaceSnapshot) -> String? {
  if snapshot.hasStopControl { return "working" }
  if snapshot.labels.contains(where: isAttentionLabel) { return "attention_needed" }
  if snapshot.labels.contains(where: isFailureLabel) { return "failed" }
  if snapshot.labels.contains(where: isStoppedLabel) { return "stopped" }
  return snapshot.hasSendControl ? "idle" : nil
}

func focusedComposerFingerprint(in appElement: AXUIElement) -> Int? {
  guard let focusedElement = elementValue(appElement, kAXFocusedUIElementAttribute as CFString) else {
    return nil
  }
  let role = stringValue(focusedElement, kAXRoleAttribute as CFString) ?? ""
  guard textRoles.contains(role),
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

func transitionStatus(_ observed: String?, trackerKey: String) -> String {
  var tracker = trackers[trackerKey] ?? SessionTracker()
  defer { trackers[trackerKey] = tracker }

  guard let observed else {
    guard tracker.sawWorking else { return "idle" }
    // Keep a reply alive through a few partial scans, but do not celebrate a
    // completion that was never seen.
    tracker.inconclusivePolls += 1
    if tracker.inconclusivePolls >= 6 {
      tracker = SessionTracker(composerFingerprint: tracker.composerFingerprint, lastComposerChange: tracker.lastComposerChange)
      return "idle"
    }
    return "working"
  }
  tracker.inconclusivePolls = 0

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

func pruneClaudeCodeSessions(at date: Date = Date()) {
  for (session, lastEvent) in claudeCodeActiveSessions where date.timeIntervalSince(lastEvent) >= claudeCodeSessionTimeout {
    claudeCodeActiveSessions.removeValue(forKey: session)
    emit("claude_code", session == "unknown" ? nil : session, "idle")
  }
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
      switch event.status {
      case "working", "attention_needed":
        claudeCodeActiveSessions[session] = Date()
      case "reply":
        // A late streamed-text hook must not revive a turn that already stopped.
        if claudeCodeActiveSessions[session] != nil { claudeCodeActiveSessions[session] = Date() }
      default:
        claudeCodeActiveSessions.removeValue(forKey: session)
      }
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

func observeDesktop(bundleID: String) -> DesktopObservation? {
  guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleID }) else {
    return nil
  }

  let trackerKey = bundleID
  let defaultSource = bundleID == "com.anthropic.claude-cowork" ? "cowork" : "chat"
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(appElement, 0.3)
  // Enable the documented Electron accessibility mode before inspecting windows.
  let activation = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  let windows = candidateWindows(appElement)
  guard !windows.isEmpty else {
    resetTracker(trackerKey)
    return DesktopObservation(source: defaultSource, session: nil, status: "unavailable", reason: "window_unavailable")
  }

  let deadline = Date().addingTimeInterval(2)
  let inTime = { Date() < deadline }
  var chosen: (window: AXUIElement, snapshot: InterfaceSnapshot)?
  var incomplete = false
  for window in windows.prefix(6) where inTime() {
    let snapshot = visibleInterface(in: window, shouldContinue: inTime)
    incomplete = incomplete || snapshot.incomplete
    if snapshot.hasComposerControls {
      chosen = (window, snapshot)
      break
    }
    if snapshot.readable && chosen == nil { chosen = (window, snapshot) }
  }
  if chosen?.snapshot.hasComposerControls != true,
     let nearby = composerSurroundings(in: appElement), nearby.hasComposerControls {
    chosen = (chosen?.window ?? windows[0], nearby)
  }

  guard let reading = chosen else {
    if incomplete && trackers[trackerKey]?.sawWorking == true {
      return DesktopObservation(source: defaultSource, session: nil,
                                status: transitionStatus(nil, trackerKey: trackerKey), reason: nil)
    }
    resetTracker(trackerKey)
    let reason = incomplete ? "interface_scanning" : activation == .cannotComplete ? "interface_unresponsive" : "interface_unavailable"
    return DesktopObservation(source: defaultSource, session: nil, status: "unavailable", reason: reason)
  }

  let transitioned = transitionStatus(directStatus(from: reading.snapshot), trackerKey: trackerKey)
  let status = transitioned == "idle" && composerIsActive(in: appElement, trackerKey: trackerKey)
    ? "message" : transitioned
  // Desktop monitoring remains status-only; previews are opt-in Code hooks.
  return DesktopObservation(source: sourceFor(selectedLabels: reading.snapshot.selectedLabels, fallback: defaultSource),
                            session: sessionFrom(title: stringValue(reading.window, kAXTitleAttribute as CFString)),
                            status: status, reason: nil)
}

func hookObject(from input: Data) -> [String: Any]? {
  (try? JSONSerialization.jsonObject(with: input)) as? [String: Any]
}

// Claude Code routes every notification through one hook. Only prompts that
// wait on the user need attention; the idle reminder means the turn is over.
func hookStatus(_ requested: String, input: Data) -> String? {
  guard requested == "attention_needed" else { return requested }
  let object = hookObject(from: input)
  let type = (object?["notification_type"] as? String) ?? (object?["type"] as? String) ?? ""
  if ["", "permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"].contains(type) {
    return "attention_needed"
  }
  return type == "idle_prompt" ? "idle" : nil
}

func hookPreview(from input: Data, includeContent: Bool) -> (String?, String?) {
  guard let object = hookObject(from: input) else { return (nil, nil) }
  let session = object["session_id"] as? String
  guard includeContent else { return (session, nil) }
  for key in ["prompt", "last_assistant_message", "delta", "message", "text", "content"] {
    if let value = object[key] as? String, !value.isEmpty { return (session, String(value.prefix(240))) }
  }
  return (session, nil)
}

func appendClaudeCodeHook(status requested: String, includeContent: Bool) {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let status = hookStatus(requested, input: input) else { return }
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
  func buttons(_ labels: [String]) -> InterfaceSnapshot {
    var snapshot = InterfaceSnapshot()
    snapshot.record(NodeInfo(role: "AXButton", labels: labels))
    snapshot.finish()
    return snapshot
  }
  let deep = scanTree(root: 0, children: { $0 < 300 ? [$0 + 1] : [] }, inspect: { NodeInfo(role: $0 == 300 ? "AXWebArea" : "AXGroup") })
  precondition(deep.readable, "Web surfaces beyond the old 180-node limit must be found")
  let nativeComposer = scanTree(root: 0, children: { $0 == 0 ? [1, 2] : [] }, inspect: {
    $0 == 1 ? NodeInfo(role: "AXTextArea") : $0 == 2 ? NodeInfo(role: "AXButton", labels: ["send message"]) : NodeInfo(role: "AXGroup")
  })
  precondition(nativeComposer.readable, "A usable composer and send button must work without an AXWebArea wrapper")
  let bounded = scanTree(root: 0, maxNodes: 180, children: { [$0 + 1] }, inspect: { _ in NodeInfo(role: "AXGroup") })
  precondition(bounded.incomplete && !bounded.readable, "A truncated tree must not be reported as definitively unreadable")
  let content = scanTree(root: 0, children: { _ in [1] }, inspect: { _ in NodeInfo(role: "AXTextArea") })
  precondition(!content.incomplete && !content.readable, "Text content must not be traversed for status detection")
  // Node 1 is an endless conversation; node 2 is the composer that follows it.
  let longChat = scanTree(root: 0, maxNodes: 200, children: { node -> [Int] in
    if node == 0 { return [1, 2] }
    if node == 2 { return [3, 4] }
    return node == 1 || node >= 10 ? [max(node, 9) + 1] : []
  }, inspect: {
    $0 == 3 ? NodeInfo(role: "AXTextArea") : $0 == 4 ? NodeInfo(role: "AXButton", labels: ["stop response"]) : NodeInfo(role: "AXGroup")
  })
  precondition(directStatus(from: longChat) == "working", "The composer after a long conversation must be read within budget")
  let tree = [0: [1, 2], 1: [3, 4], 2: [5]]
  let parents = [1: 0, 2: 0, 3: 1, 4: 1, 5: 2]
  let around = scanAround(start: 3, parent: { parents[$0] }, children: { tree[$0] ?? [] }, inspect: {
    $0 == 3 ? NodeInfo(role: "AXTextArea") : $0 == 5 ? NodeInfo(role: "AXButton", labels: ["send message"]) : NodeInfo(role: "AXGroup")
  }, same: { $0 == $1 })
  precondition(around.readable && directStatus(from: around) == "idle", "The focused composer must lead to its Send control")
  precondition(directStatus(from: buttons(["extended thinking", "send message"])) == "idle", "Composer options must not look like work")
  precondition(directStatus(from: buttons(["stop response"])) == "working")
  precondition(directStatus(from: buttons(["stop recording", "send message"])) == "idle", "Dictation must not look like a reply")
  precondition(directStatus(from: buttons(["allow once", "send message"])) == "attention_needed")
  precondition(directStatus(from: buttons(["new chat"])) == nil, "A scan without the composer must be inconclusive")
  precondition(sourceFor(selectedLabels: ["cowork"], fallback: "chat") == "cowork")
  precondition(sourceFor(selectedLabels: [], fallback: "chat") == "chat", "An unselected Cowork tab must not relabel Chat")
  precondition(transitionStatus("working", trackerKey: "test") == "working")
  precondition(transitionStatus("idle", trackerKey: "test") == "working")
  precondition(transitionStatus("idle", trackerKey: "test") == "completed")
  precondition(transitionStatus("idle", trackerKey: "test") == "idle")
  precondition(transitionStatus("working", trackerKey: "partial") == "working")
  for _ in 0..<5 {
    precondition(transitionStatus(nil, trackerKey: "partial") == "working", "A partial scan must not end a reply")
  }
  precondition(transitionStatus(nil, trackerKey: "partial") == "idle", "A reply that stays unreadable must not stay working")
  precondition(!pollClaudeCodeHooks(), "No queue should mean no event")
  let prompt = ClaudeEvent(source: "claude_code", session: "test", status: "working", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(prompt) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  precondition(pollClaudeCodeHooks(), "The first live queue must be read")
  precondition(claudeCodeActiveSessions["test"] != nil, "The first prompt must not be discarded")
  let stop = ClaudeEvent(source: "claude_code", session: "test", status: "completed", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(stop) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  _ = pollClaudeCodeHooks()
  precondition(claudeCodeActiveSessions.isEmpty, "Stop must clear the working session")
  let lateReply = ClaudeEvent(source: "claude_code", session: "test", status: "reply", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(lateReply) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  _ = pollClaudeCodeHooks()
  precondition(claudeCodeActiveSessions.isEmpty, "A late reply hook must not revive a finished turn")
  claudeCodeActiveSessions["interrupted"] = Date().addingTimeInterval(-claudeCodeSessionTimeout - 1)
  pruneClaudeCodeSessions()
  precondition(claudeCodeActiveSessions.isEmpty, "An interrupted Claude Code turn must not block Desktop monitoring forever")
  precondition(hookStatus("attention_needed", input: Data(#"{"notification_type":"idle_prompt"}"#.utf8)) == "idle")
  precondition(hookStatus("attention_needed", input: Data(#"{"notification_type":"permission_prompt"}"#.utf8)) == "attention_needed")
  precondition(hookStatus("attention_needed", input: Data(#"{"notification_type":"auth_success"}"#.utf8)) == nil)
  precondition(hookStatus("completed", input: Data()) == "completed")
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
    var observation = observeDesktop(bundleID: bundleID)
    var attempts = 0
    // Electron builds its accessibility tree asynchronously once
    // AXManualAccessibility is enabled, so the first read can be empty.
    while attempts < 4, observation?.status == "unavailable", observation?.reason?.hasPrefix("interface_") == true {
      attempts += 1
      Thread.sleep(forTimeInterval: 0.6)
      observation = observeDesktop(bundleID: bundleID)
    }
    if let observation {
      emit(observation)
      found = true
    }
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
  pruneClaudeCodeSessions()
  // Live Claude Code work must not be erased by an idle Desktop, but Desktop
  // activity is still reported so Chat keeps syncing while Code is open.
  let claudeCodeHoldsStatus = !claudeCodeActiveSessions.isEmpty
    || (lastClaudeCodeEventAt.map { Date().timeIntervalSince($0) < 4 } ?? false)
  guard isAccessibilityTrusted() else {
    if !claudeCodeHoldsStatus { emit("system", nil, "unavailable", reason: "permission_denied") }
    Thread.sleep(forTimeInterval: 1.2)
    continue
  }

  var observedApp = false
  for bundleID in supportedApps {
    guard let observation = observeDesktop(bundleID: bundleID) else { continue }
    observedApp = true
    if claudeCodeHoldsStatus && ["idle", "unavailable"].contains(observation.status) { continue }
    emit(observation)
  }
  if !observedApp && !hasClaudeCodeHooks {
    trackers.removeAll()
    emit("system", nil, "unavailable", reason: "claude_not_running")
  }
  Thread.sleep(forTimeInterval: 1)
}
