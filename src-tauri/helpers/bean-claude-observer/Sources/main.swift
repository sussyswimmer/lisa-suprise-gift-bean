import ApplicationServices
import AppKit
import Foundation

struct ClaudeEvent: Codable {
  let source: String
  let session: String?
  let status: String
  let timestamp: String
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

func now() -> String {
  ISO8601DateFormatter().string(from: Date())
}

func emit(_ source: String, _ session: String?, _ status: String) {
  let event = ClaudeEvent(source: source, session: session, status: status, timestamp: now())
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
  emit(source, sessionFrom(title: title), status)
  return true
}

let args = CommandLine.arguments
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
  guard isAccessibilityTrusted() else {
    emit("system", nil, "unavailable")
    Thread.sleep(forTimeInterval: 2)
    continue
  }

  var observedApp = false
  for bundleID in supportedApps {
    observedApp = pollAccessibility(for: bundleID) || observedApp
  }
  if !observedApp {
    emit("system", nil, "unavailable")
  }
  Thread.sleep(forTimeInterval: 1.2)
}
