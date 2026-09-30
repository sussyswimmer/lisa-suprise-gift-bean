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
  // The chat's name, such as a Claude Desktop conversation title or a Claude
  // Code project folder. Shown above Bean; never message text.
  var title: String? = nil
}

struct SessionTracker {
  var sawWorking = false
  var quietPolls = 0
  var inconclusivePolls = 0
  var composerFingerprint: Int?
  var lastComposerChange: Date?
  var lastSource: String?
}

struct DesktopObservation {
  let source: String
  let session: String?
  let status: String
  let reason: String?
  var title: String? = nil
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
// The chat each app showed last, so a partial scan keeps its reply alive.
struct VisibleChat {
  var key: String
  var session: String?
  var title: String?
}
var lastChats = [String: VisibleChat]()
var claudeCodeEventOffset: UInt64 = 0
var claudeCodeHooksAvailable = false
struct ClaudeCodeSession {
  var startedAt: Date
  var lastEvent: Date
  var status: String
  var title: String? = nil
}

// Claude Code sessions that are working or waiting on the user. Interrupting
// Claude Code with Esc fires no Stop hook, so entries expire instead of hiding
// Claude Desktop activity forever.
var claudeCodeActiveSessions = [String: ClaudeCodeSession]()
// Sessions that just ended, so a tool result racing their Stop cannot revive them.
var recentlyEndedClaudeCodeSessions = [String: Date]()
// No hook says when a permission prompt was answered before the tool finishes,
// so after this long a waiting session counts as working again.
let claudeCodeAttentionWindow: TimeInterval = 120
var lastEmitted: (source: String, session: String?, status: String)?
let claudeCodeSessionTimeout: TimeInterval = 30 * 60
var lastClaudeCodeEventAt: Date?
var claudeCodeEventsURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/Bean/claude-code-events")

func now() -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date())
}

func emit(_ source: String, _ session: String?, _ status: String, _ preview: String? = nil, reason: String? = nil,
          title: String? = nil) {
  let event = ClaudeEvent(source: source, session: session, status: status, timestamp: now(), preview: preview, reason: reason,
                          title: title)
  guard let data = try? JSONEncoder().encode(event), let line = String(data: data, encoding: .utf8) else {
    return
  }
  print(line)
  fflush(stdout)
  lastEmitted = (source, session, status)
}

func emit(_ observation: DesktopObservation) {
  emit(observation.source, observation.session, observation.status, reason: observation.reason, title: observation.title)
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

// Labels are matched exactly: buttons named from their contents, such as a chat
// titled "Stop words in NLP", must not pin Bean to a state.
let sendLabels: Set<String> = ["send", "send message", "send prompt", "submit message", "start task"]
// Dictation and sharing controls also say "Stop"; they are not Claude replying.
let stopLabels: Set<String> = [
  "stop", "stop response", "stop generating", "stop responding", "stop streaming", "stop task", "interrupt",
  "cancel response", "cancel generation", "cancel task",
]
let attentionLabels: Set<String> = [
  "approve", "allow", "deny", "always allow", "allow always", "allow once", "allow for this chat",
  "allow for this conversation", "allow for this task", "allow for this session", "needs attention",
  "attention required", "review required", "requires approval", "needs your approval", "waiting for approval",
  "permission required",
]
let failureLabels: Set<String> = [
  "generation failed", "response failed", "something went wrong", "error occurred", "message failed", "failed to send",
]
let stoppedLabels: Set<String> = ["generation stopped", "response stopped", "response was interrupted", "response interrupted"]

func isSendLabel(_ label: String) -> Bool { sendLabels.contains(label) }
func isStopLabel(_ label: String) -> Bool { stopLabels.contains(label) }
func isAttentionLabel(_ label: String) -> Bool { attentionLabels.contains(label) }
func isFailureLabel(_ label: String) -> Bool { failureLabels.contains(label) }
func isStoppedLabel(_ label: String) -> Bool { stoppedLabels.contains(label) }

struct NodeInfo {
  var role: String
  var labels = [String]()
  var selected = false
  // A web area's document title and address, which name the open chat.
  var documentTitle: String? = nil
  var documentURL: String? = nil
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
  var documentTitle: String?
  var documentURL: String?

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
    // The first web area reached holds the composer; later ones are sidebars.
    if documentTitle == nil, let title = chatTitle(from: info.documentTitle) { documentTitle = title }
    if documentURL == nil, let url = info.documentURL, !url.isEmpty { documentURL = url }
  }

  mutating func merge(_ other: InterfaceSnapshot) {
    labels.append(contentsOf: other.labels)
    selectedLabels.append(contentsOf: other.selectedLabels)
    readable = readable || other.readable
    hasComposer = hasComposer || other.hasComposer
    hasSendControl = hasSendControl || other.hasSendControl
    hasStopControl = hasStopControl || other.hasStopControl
    visited += other.visited
    documentTitle = documentTitle ?? other.documentTitle
    documentURL = documentURL ?? other.documentURL
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
  if role == "AXWebArea" {
    return NodeInfo(role: role, documentTitle: stringValue(element, kAXTitleAttribute as CFString),
                    documentURL: stringValue(element, "AXURL" as CFString) ?? urlValue(element))
  }
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

// Chromium reports a web area's address as a URL object rather than a string.
func urlValue(_ element: AXUIElement) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, "AXURL" as CFString, &value) == .success,
        let object = value, CFGetTypeID(object) == CFURLGetTypeID() else {
    return nil
  }
  return (object as! URL).absoluteString
}

// Claude titles its page "<chat name> - Claude"; keep just the chat's name.
func chatTitle(from raw: String?) -> String? {
  guard var title = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { return nil }
  for suffix in [" - Claude", " – Claude", " — Claude", " | Claude", " · Claude"] where title.hasSuffix(suffix) {
    title = String(title.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  let generic: Set<String> = ["claude", "claude desktop", "anthropic claude", "new chat", "new task", "untitled"]
  return title.isEmpty || generic.contains(title.lowercased()) ? nil : title
}

// A stable name for the open chat: its conversation ID from the address when
// Claude exposes one, otherwise its title.
func chatSession(url: String?, title: String?) -> String? {
  if let url = url, let components = URLComponents(string: url) {
    let parts = components.path.split(separator: "/").map(String.init)
    if parts.count >= 2, ["chat", "task", "project", "code"].contains(parts[parts.count - 2]) {
      return "\(parts[parts.count - 2])/\(parts[parts.count - 1])"
    }
  }
  return title
}

// Returns nil when the scan never reached the composer, so a partial read
// cannot be mistaken for Claude finishing its reply.
func directStatus(from snapshot: InterfaceSnapshot) -> String? {
  // Claude keeps its Stop button while a permission prompt waits on the user.
  if snapshot.labels.contains(where: isAttentionLabel) { return "attention_needed" }
  if snapshot.hasStopControl { return "working" }
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
      tracker = SessionTracker(composerFingerprint: tracker.composerFingerprint, lastComposerChange: tracker.lastComposerChange,
                               lastSource: tracker.lastSource)
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

// Every chat of one app, which is tracked separately so switching chats while
// one replies neither ends that reply nor celebrates the chat you opened.
func resetTrackers(for bundleID: String) {
  trackers = trackers.filter { $0.key != bundleID && !$0.key.hasPrefix(bundleID + "|") }
}

func pruneClaudeCodeSessions(at date: Date = Date()) {
  let expired = claudeCodeActiveSessions.filter { date.timeIntervalSince($0.value.lastEvent) >= claudeCodeSessionTimeout }
  for session in expired.keys { claudeCodeActiveSessions.removeValue(forKey: session) }
  // Sessions still running are re-shown by the main loop; report idle only
  // when none are left.
  if let session = expired.keys.first, claudeCodeActiveSessions.isEmpty {
    emit("claude_code", session == "unknown" ? nil : session, "idle")
  }
}

func isWaitingOnUser(_ active: ClaudeCodeSession, at date: Date = Date()) -> Bool {
  active.status == "attention_needed" && date.timeIntervalSince(active.lastEvent) < claudeCodeAttentionWindow
}

// A session waiting on the user outranks sessions that are only working.
// Among equals, the turn that started last wins; tool results do not reorder
// them, so parallel sessions cannot keep swapping which one Bean shows.
func claudeCodePriority(at date: Date = Date()) -> (session: String, status: String)? {
  let waiting = claudeCodeActiveSessions.filter { isWaitingOnUser($0.value, at: date) }
  let pool = waiting.isEmpty ? claudeCodeActiveSessions : waiting
  guard let latest = pool.max(by: { $0.value.startedAt < $1.value.startedAt }) else { return nil }
  return (latest.key, waiting.isEmpty ? "working" : "attention_needed")
}

// Whether Bean already shows this Claude Code state. A streamed reply counts
// as working, as does another active session in the same state.
func claudeCodeStatusShown(_ priority: (session: String, status: String)) -> Bool {
  guard let last = lastEmitted, last.source == "claude_code" else { return false }
  let lastStatus = last.status == "reply" ? "working" : last.status
  guard lastStatus == priority.status else { return false }
  let lastSession = last.session ?? "unknown"
  return lastSession == priority.session || claudeCodeActiveSessions[lastSession] != nil
}

// Applies one Claude Code hook event and says whether Bean should show it.
func recordClaudeCodeEvent(session: String, status: String, at date: Date = Date()) -> String? {
  recentlyEndedClaudeCodeSessions = recentlyEndedClaudeCodeSessions.filter { date.timeIntervalSince($0.value) < 30 }
  switch status {
  case "working":
    recentlyEndedClaudeCodeSessions.removeValue(forKey: session)
    claudeCodeActiveSessions[session] = ClaudeCodeSession(startedAt: date, lastEvent: date, status: status)
  case "attention_needed":
    let startedAt = claudeCodeActiveSessions[session]?.startedAt ?? date
    claudeCodeActiveSessions[session] = ClaudeCodeSession(startedAt: startedAt, lastEvent: date, status: status)
  case "heartbeat":
    // A finished tool call keeps a turn alive. It is shown only when it ends
    // this session's permission prompt, or reveals a turn that began before
    // this helper started.
    if var active = claudeCodeActiveSessions[session] {
      let answered = active.status == "attention_needed"
      active.lastEvent = date
      active.status = "working"
      claudeCodeActiveSessions[session] = active
      if !answered { return nil }
    } else {
      guard recentlyEndedClaudeCodeSessions[session] == nil else { return nil }
      claudeCodeActiveSessions[session] = ClaudeCodeSession(startedAt: date, lastEvent: date, status: "working")
    }
  case "reply":
    // A late streamed-text hook must not revive a turn that already stopped.
    guard claudeCodeActiveSessions[session] != nil else { return nil }
    claudeCodeActiveSessions[session]?.lastEvent = date
  case "idle":
    // Claude Code's idle reminder returns Bean to idle after a turn (nothing
    // else does when Claude Desktop is closed), unless another session runs.
    claudeCodeActiveSessions.removeValue(forKey: session)
    recentlyEndedClaudeCodeSessions[session] = date
    if !claudeCodeActiveSessions.isEmpty { return nil }
  default:
    claudeCodeActiveSessions.removeValue(forKey: session)
    recentlyEndedClaudeCodeSessions[session] = date
  }
  let shown = status == "heartbeat" ? "working" : status
  let otherSessionWaiting = claudeCodeActiveSessions.contains { $0.key != session && isWaitingOnUser($0.value, at: date) }
  if otherSessionWaiting && ["working", "reply"].contains(shown) { return nil }
  return shown
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
      lastClaudeCodeEventAt = Date()
      let session = event.session ?? "unknown"
      let shown = recordClaudeCodeEvent(session: session, status: event.status)
      if let title = event.title { claudeCodeActiveSessions[session]?.title = title }
      if let shown = shown {
        emit(event.source, event.session, shown, event.preview,
             title: event.title ?? claudeCodeActiveSessions[session]?.title)
      }
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
  // Query each poll: NSWorkspace.runningApplications is a cached list that only
  // refreshes while a run loop runs, so it can miss Claude launching or relaunching.
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first(where: { !$0.isTerminated }) else {
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
    resetTrackers(for: bundleID)
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
    if incomplete, let last = lastChats[bundleID], trackers[last.key]?.sawWorking == true {
      return DesktopObservation(source: trackers[bundleID]?.lastSource ?? defaultSource, session: last.session,
                                status: transitionStatus(nil, trackerKey: last.key), reason: nil, title: last.title)
    }
    resetTrackers(for: bundleID)
    let reason = incomplete ? "interface_scanning" : activation == .cannotComplete ? "interface_unresponsive" : "interface_unavailable"
    return DesktopObservation(source: defaultSource, session: nil, status: "unavailable", reason: reason)
  }

  let windowTitle = chatTitle(from: stringValue(reading.window, kAXTitleAttribute as CFString))
  let title = reading.snapshot.documentTitle ?? windowTitle
  let session = chatSession(url: reading.snapshot.documentURL, title: title)
  let chatKey = session.map { "\(bundleID)|\($0)" } ?? bundleID
  lastChats[bundleID] = VisibleChat(key: chatKey, session: session, title: title)
  let transitioned = transitionStatus(directStatus(from: reading.snapshot), trackerKey: chatKey)
  let status = transitioned == "idle" && composerIsActive(in: appElement, trackerKey: trackerKey)
    ? "message" : transitioned
  // The scan rarely reaches the Chat/Cowork switcher, so keep the last mode it saw.
  let source = sourceFor(selectedLabels: reading.snapshot.selectedLabels,
                         fallback: trackers[trackerKey]?.lastSource ?? defaultSource)
  trackers[trackerKey, default: SessionTracker()].lastSource = source
  // Desktop monitoring remains status-only; previews are opt-in Code hooks.
  return DesktopObservation(source: source, session: session, status: status, reason: nil, title: title)
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

// Names a Claude Code session after its project folder.
func hookTitle(from input: Data) -> String? {
  guard let cwd = hookObject(from: input)?["cwd"] as? String, !cwd.isEmpty else { return nil }
  let name = URL(fileURLWithPath: cwd).lastPathComponent
  return name.isEmpty || name == "/" ? nil : name
}

func appendClaudeCodeHook(status requested: String, includeContent: Bool) {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let status = hookStatus(requested, input: input) else { return }
  let (session, preview) = hookPreview(from: input, includeContent: includeContent)
  let event = ClaudeEvent(source: "claude_code", session: session, status: status, timestamp: now(), preview: preview, reason: nil,
                          title: hookTitle(from: input))
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
  // Fake accessibility trees over Int node ids. Closures are typed explicitly
  // so the Swift type checker never has to infer a long generic expression.
  func group(_ role: String = "AXGroup", _ labels: [String] = []) -> NodeInfo {
    NodeInfo(role: role, labels: labels)
  }
  let deepChildren: (Int) -> [Int] = { node in node < 300 ? [node + 1] : [] }
  let deepInspect: (Int) -> NodeInfo = { node in group(node == 300 ? "AXWebArea" : "AXGroup") }
  let deep = scanTree(root: 0, children: deepChildren, inspect: deepInspect)
  precondition(deep.readable, "Web surfaces beyond the old 180-node limit must be found")
  let composerChildren: (Int) -> [Int] = { node in node == 0 ? [1, 2] : [] }
  let composerInspect: (Int) -> NodeInfo = { node in
    if node == 1 { return group("AXTextArea") }
    if node == 2 { return group("AXButton", ["send message"]) }
    return group()
  }
  let nativeComposer = scanTree(root: 0, children: composerChildren, inspect: composerInspect)
  precondition(nativeComposer.readable, "A usable composer and send button must work without an AXWebArea wrapper")
  let chainChildren: (Int) -> [Int] = { node in [node + 1] }
  let plainGroup: (Int) -> NodeInfo = { _ in group() }
  let bounded = scanTree(root: 0, maxNodes: 180, children: chainChildren, inspect: plainGroup)
  precondition(bounded.incomplete && !bounded.readable, "A truncated tree must not be reported as definitively unreadable")
  let textChildren: (Int) -> [Int] = { _ in [1] }
  let textArea: (Int) -> NodeInfo = { _ in group("AXTextArea") }
  let content = scanTree(root: 0, children: textChildren, inspect: textArea)
  precondition(!content.incomplete && !content.readable, "Text content must not be traversed for status detection")
  // Node 1 is an endless conversation; node 2 is the composer that follows it.
  let longChatChildren: (Int) -> [Int] = { node in
    if node == 0 { return [1, 2] }
    if node == 2 { return [3, 4] }
    if node == 1 || node >= 10 { return [max(node, 9) + 1] }
    return []
  }
  let longChatInspect: (Int) -> NodeInfo = { node in
    if node == 3 { return group("AXTextArea") }
    if node == 4 { return group("AXButton", ["stop response"]) }
    return group()
  }
  let longChat = scanTree(root: 0, maxNodes: 200, children: longChatChildren, inspect: longChatInspect)
  precondition(directStatus(from: longChat) == "working", "The composer after a long conversation must be read within budget")
  let tree: [Int: [Int]] = [0: [1, 2], 1: [3, 4], 2: [5]]
  let parents: [Int: Int] = [1: 0, 2: 0, 3: 1, 4: 1, 5: 2]
  let aroundParent: (Int) -> Int? = { node in parents[node] }
  let aroundChildren: (Int) -> [Int] = { node in tree[node] ?? [] }
  let aroundInspect: (Int) -> NodeInfo = { node in
    if node == 3 { return group("AXTextArea") }
    if node == 5 { return group("AXButton", ["send message"]) }
    return group()
  }
  let sameNode: (Int, Int) -> Bool = { first, second in first == second }
  let around = scanAround(start: 3, parent: aroundParent, children: aroundChildren, inspect: aroundInspect, same: sameNode)
  precondition(around.readable && directStatus(from: around) == "idle", "The focused composer must lead to its Send control")
  precondition(directStatus(from: buttons(["extended thinking", "send message"])) == "idle", "Composer options must not look like work")
  precondition(directStatus(from: buttons(["stop response"])) == "working")
  precondition(directStatus(from: buttons(["stop recording", "send message"])) == "idle", "Dictation must not look like a reply")
  precondition(directStatus(from: buttons(["allow once", "send message"])) == "attention_needed")
  precondition(directStatus(from: buttons(["stop response", "always allow", "allow once", "deny"])) == "attention_needed",
               "A permission prompt during a reply must need attention")
  precondition(directStatus(from: buttons(["stop words in nlp preprocessing", "send message"])) == "idle",
               "A chat titled Stop… must not look like a reply")
  precondition(directStatus(from: buttons(["approve q3 budget", "send message"])) == "idle",
               "A chat titled Approve… must not need attention")
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
  precondition(claudeCodeActiveSessions["test"]?.status == "working", "The first prompt must not be discarded")
  let stop = ClaudeEvent(source: "claude_code", session: "test", status: "completed", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(stop) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  _ = pollClaudeCodeHooks()
  precondition(claudeCodeActiveSessions.isEmpty, "Stop must clear the working session")
  let lateReply = ClaudeEvent(source: "claude_code", session: "test", status: "reply", timestamp: now(), preview: nil, reason: nil)
  try (JSONEncoder().encode(lateReply) + Data("\n".utf8)).write(to: claudeCodeEventsURL)
  _ = pollClaudeCodeHooks()
  precondition(claudeCodeActiveSessions.isEmpty, "A late reply hook must not revive a finished turn")
  let longAgo = Date().addingTimeInterval(-claudeCodeSessionTimeout - 1)
  claudeCodeActiveSessions["interrupted"] = ClaudeCodeSession(startedAt: longAgo, lastEvent: longAgo, status: "working")
  pruneClaudeCodeSessions()
  precondition(claudeCodeActiveSessions.isEmpty, "An interrupted Claude Code turn must not block Desktop monitoring forever")
  precondition(recordClaudeCodeEvent(session: "a", status: "working") == "working")
  precondition(recordClaudeCodeEvent(session: "a", status: "heartbeat") == nil, "Tool results must not repeat working")
  precondition(recordClaudeCodeEvent(session: "a", status: "attention_needed") == "attention_needed")
  precondition(recordClaudeCodeEvent(session: "b", status: "working") == nil, "Other work must not hide a permission prompt")
  precondition(claudeCodePriority()?.session == "a" && claudeCodePriority()?.status == "attention_needed")
  precondition(recordClaudeCodeEvent(session: "a", status: "heartbeat") == "working", "Answering a prompt resumes work")
  precondition(recordClaudeCodeEvent(session: "b", status: "completed") == "completed")
  precondition(recordClaudeCodeEvent(session: "b", status: "heartbeat") == nil && claudeCodeActiveSessions["b"] == nil,
               "A tool result racing Stop must not revive a session")
  precondition(recordClaudeCodeEvent(session: "early", status: "heartbeat") == "working",
               "A turn that began before the helper must show once its tools report")
  precondition(recordClaudeCodeEvent(session: "b", status: "reply") == nil, "A reply after Stop must not be shown")
  precondition(recordClaudeCodeEvent(session: "ghost", status: "idle") == nil, "An idle reminder must not hide running sessions")
  lastEmitted = ("claude_code", "a", "reply")
  precondition(claudeCodeStatusShown(("a", "working")), "A streamed reply already shows the session working")
  precondition(claudeCodeStatusShown(("early", "working")), "Another working session must not be re-shown")
  claudeCodeActiveSessions.removeAll()
  let base = Date()
  _ = recordClaudeCodeEvent(session: "first", status: "working", at: base)
  _ = recordClaudeCodeEvent(session: "second", status: "working", at: base.addingTimeInterval(1))
  _ = recordClaudeCodeEvent(session: "first", status: "heartbeat", at: base.addingTimeInterval(2))
  precondition(claudeCodePriority(at: base.addingTimeInterval(2))?.session == "second",
               "Tool results must not swap which working session Bean shows")
  _ = recordClaudeCodeEvent(session: "first", status: "attention_needed", at: base.addingTimeInterval(3))
  precondition(claudeCodePriority(at: base.addingTimeInterval(4))?.status == "attention_needed")
  precondition(claudeCodePriority(at: base.addingTimeInterval(3 + claudeCodeAttentionWindow))?.status == "working",
               "An unanswered-looking prompt must not claim attention forever")
  claudeCodeActiveSessions.removeAll()
  precondition(recordClaudeCodeEvent(session: "done", status: "idle") == "idle",
               "The idle reminder must return Bean to idle once no turn is running")
  recentlyEndedClaudeCodeSessions.removeAll()
  lastEmitted = nil
  precondition(hookStatus("attention_needed", input: Data(#"{"notification_type":"idle_prompt"}"#.utf8)) == "idle")
  precondition(hookStatus("attention_needed", input: Data(#"{"notification_type":"permission_prompt"}"#.utf8)) == "attention_needed")
  precondition(hookStatus("attention_needed", input: Data(#"{"notification_type":"auth_success"}"#.utf8)) == nil)
  precondition(hookStatus("completed", input: Data()) == "completed")
  let input = Data(#"{"session_id":"test","last_assistant_message":"Final reply"}"#.utf8)
  precondition(hookPreview(from: input, includeContent: true).1 == "Final reply", "Stop must read the documented reply field")
  precondition(hookPreview(from: input, includeContent: false).0 == "test", "Status-only hooks must retain session identity")
  precondition(hookPreview(from: input, includeContent: false).1 == nil, "Status-only hooks must not expose text")
  precondition(chatTitle(from: "Trip ideas - Claude") == "Trip ideas", "Chat titles drop Claude's suffix")
  precondition(chatTitle(from: "Claude") == nil && chatTitle(from: " New chat ") == nil, "Generic titles are not chat names")
  let chatURL = "https://claude.ai/chat/1234-abcd"
  precondition(chatSession(url: chatURL, title: "Trip ideas") == "chat/1234-abcd", "Chats are keyed by their address")
  precondition(chatSession(url: nil, title: "Trip ideas") == "Trip ideas", "Chats fall back to their title")
  precondition(hookTitle(from: Data(#"{"cwd":"/Users/me/bean"}"#.utf8)) == "bean", "Code sessions are named after their folder")
  var titled = InterfaceSnapshot()
  titled.record(NodeInfo(role: "AXWebArea", documentTitle: "Trip ideas - Claude", documentURL: chatURL))
  titled.record(NodeInfo(role: "AXWebArea", documentTitle: "Sidebar - Claude", documentURL: "https://claude.ai/recents"))
  precondition(titled.documentTitle == "Trip ideas" && titled.documentURL == chatURL, "The first web area names the chat")
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
// Prints what Bean can read from Claude's window: control roles and labels
// only, never message or composer text. Saved from the menu bar so a person
// can send it along when Bean misreads Claude.
if args.contains("--diagnose") {
  print("Bean diagnostics \(now())")
  print("Accessibility allowed: \(isAccessibilityTrusted())")
  for bundleID in supportedApps {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
      .first(where: { !$0.isTerminated }) else {
      print("\(bundleID): not running")
      continue
    }
    let version = app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String } ?? "?"
    print("\(bundleID): running, version \(version)")
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appElement, 1)
    let activation = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    print("  manual accessibility: \(activation.rawValue)")
    Thread.sleep(forTimeInterval: 0.8)
    let windows = candidateWindows(appElement)
    print("  windows: \(windows.count)")
    for (index, window) in windows.prefix(6).enumerated() {
      var controls = [String]()
      let deadline = Date().addingTimeInterval(4)
      let inspect: (AXUIElement) -> NodeInfo = { element in
        let info = inspectElement(element)
        if !info.labels.isEmpty && controls.count < 120 {
          controls.append("\(info.role)\(info.selected ? " [selected]" : ""): \(info.labels.joined(separator: " | "))")
        }
        return info
      }
      let snapshot = scanTree(root: window, maxNodes: 8_000, extraNodesAfterControls: 8_000,
                              children: childElements, inspect: inspect,
                              shouldContinue: { Date() < deadline })
      let reading = directStatus(from: snapshot) ?? "none"
      print("  window \(index + 1): nodes \(snapshot.visited), web area \(snapshot.readable), composer \(snapshot.hasComposer)")
      print("    send \(snapshot.hasSendControl), stop \(snapshot.hasStopControl), reads \(reading)")
      for line in controls { print("    \(line)") }
    }
    if let nearby = composerSurroundings(in: appElement) {
      print("  around composer: send \(nearby.hasSendControl), stop \(nearby.hasStopControl), labels \(nearby.labels.suffix(20))")
    } else {
      print("  around composer: composer not focused")
    }
    if let observation = observeDesktop(bundleID: bundleID) {
      print("  Bean shows: \(observation.source) \(observation.status) \(observation.reason ?? "")")
    }
  }
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

// Keep the main run loop alive between polls. AppKit delivers workspace and
// accessibility notifications through it, and run(until:) returns at once
// when the loop has no sources.
let runLoopKeepAlive = Timer(timeInterval: 3_600, repeats: true) { _ in }
RunLoop.main.add(runLoopKeepAlive, forMode: .common)
func waitForNextPoll(_ seconds: TimeInterval) {
  RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}

while true {
  let hasClaudeCodeHooks = pollClaudeCodeHooks() || claudeCodeHooksAvailable
  pruneClaudeCodeSessions()
  // Live Claude Code work must not be erased by an idle Desktop, but Desktop
  // activity is still reported so Chat keeps syncing while Code is open.
  let claudeCodeHoldsStatus = !claudeCodeActiveSessions.isEmpty
    || (lastClaudeCodeEventAt.map { Date().timeIntervalSince($0) < 4 } ?? false)
  let claudeCodeWaiting = claudeCodePriority()?.status == "attention_needed"
  guard isAccessibilityTrusted() else {
    if !claudeCodeHoldsStatus { emit("system", nil, "unavailable", reason: "permission_denied") }
    waitForNextPoll(1.2)
    continue
  }

  var observedApp = false
  var desktopShown = false
  for bundleID in supportedApps {
    guard let observation = observeDesktop(bundleID: bundleID) else { continue }
    observedApp = true
    if claudeCodeHoldsStatus && ["idle", "unavailable"].contains(observation.status) { continue }
    // A Claude Code permission prompt stays on screen over Chat progress for
    // its attention window; Chat results and Chat's own prompts still show.
    if claudeCodeWaiting && ["working", "message"].contains(observation.status) { continue }
    emit(observation)
    desktopShown = true
  }
  // Once Desktop goes quiet, show the Claude Code state that other activity
  // covered up. The app holds anything that arrives during a celebration and
  // applies it afterwards, so this can be sent right away.
  if !desktopShown, let priority = claudeCodePriority(), !claudeCodeStatusShown(priority) {
    emit("claude_code", priority.session == "unknown" ? nil : priority.session, priority.status,
         title: claudeCodeActiveSessions[priority.session]?.title)
  }
  if !observedApp && !hasClaudeCodeHooks {
    trackers.removeAll()
    lastChats.removeAll()
    emit("system", nil, "unavailable", reason: "claude_not_running")
  }
  waitForNextPoll(1)
}
