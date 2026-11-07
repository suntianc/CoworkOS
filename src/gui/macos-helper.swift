import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import Carbon
import CryptoKit
import LocalAuthentication

struct Failure: Error { let message: String; let code: String; let dispatchStatus: String }
// The helper executes one request, so this status cannot leak between requests.
var inputDispatchStatus = "not_sent"
var axSnapshotIncomplete = false
func fail(_ message: String, _ code: String = "native_rejected") throws -> Never {
    throw Failure(message: message, code: code, dispatchStatus: inputDispatchStatus)
}
func controlBlockReason() -> String {
    guard let foreground = NSWorkspace.shared.frontmostApplication,
          foreground.bundleIdentifier != "com.apple.loginwindow" else { return "桌面已锁定或没有可操作的前台应用，请解锁后重试" }
    if IsSecureEventInputEnabled() { return "系统正在使用安全键盘输入，请退出密码输入框或处理系统弹窗后重试" }
    if !CGPreflightPostEventAccess() { return "系统未允许发送输入事件，请检查辅助功能权限后重试" }
    return ""
}
func windows() -> [[String: Any]] {
    let values = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return values.compactMap { window in
        guard let pid = window[kCGWindowOwnerPID as String] as? Int32,
              let id = window[kCGWindowNumber as String] as? UInt32,
              let app = NSRunningApplication(processIdentifier: pid),
              app.activationPolicy == .regular,
              let bundle = app.bundleIdentifier,
              (window[kCGWindowLayer as String] as? Int) == 0 else { return nil }
        return ["pid": Int(pid), "windowId": Int(id), "bundleId": bundle,
                "application": app.localizedName ?? bundle,
                "title": window[kCGWindowName as String] as? String ?? ""]
    }
}
func checkTarget(_ request: [String: Any]) throws -> (NSRunningApplication, UInt32, CGRect) {
    guard let target = request["target"] as? [String: Any],
          let pid = target["pid"] as? Int32, let windowID = target["windowId"] as? UInt32,
          let bundle = target["bundleId"] as? String,
          let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
          app.bundleIdentifier == bundle else { try fail("目标应用已退出或身份已变化") }
    let values = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]] ?? []
    guard let window = values.first,
          (window[kCGWindowOwnerPID as String] as? Int32) == pid,
          (window[kCGWindowIsOnscreen as String] as? Bool) == true,
          let bounds = window[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds), frame.width >= 1, frame.height >= 1 else {
        try fail("目标窗口已关闭、隐藏或无有效尺寸")
    }
    return (app, windowID, frame)
}
func windowElement(_ pid: pid_t, _ frame: CGRect) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let candidates = value as? [AXUIElement] else { return nil }
    for candidate in candidates {
        var position: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(candidate, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(candidate, kAXSizeAttribute as CFString, &size) == .success,
              let position = position, let size = size,
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { continue }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &p),
              AXValueGetValue(size as! AXValue, .cgSize, &s) else { continue }
        if abs(p.x - frame.minX) < 1 && abs(p.y - frame.minY) < 1 &&
           abs(s.width - frame.width) < 1 && abs(s.height - frame.height) < 1 { return candidate }
    }
    return nil
}
func axAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if result != .success {
        // Unsupported/no-value optional attributes are normal. A transport or
        // invalid-element failure makes absence unprovable in this observation.
        if result != .attributeUnsupported && result != .noValue { axSnapshotIncomplete = true }
        return nil
    }
    return value
}
func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    return axAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func axNode(_ element: AXUIElement, _ path: [Int]) -> [String: Any] {
    let observedRole = axAttribute(element, kAXRoleAttribute) as? String
    if observedRole == nil { axSnapshotIncomplete = true }
    let role = observedRole ?? "AXUnknown"
    let subrole = axAttribute(element, kAXSubroleAttribute) as? String ?? ""
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
    let title = axAttribute(element, kAXTitleAttribute) as? String ?? ""
    let description = axAttribute(element, kAXDescriptionAttribute) as? String ?? ""
    let name = title.isEmpty ? description : title
    // Secure text is neither returned nor included in fingerprints/action parameters.
    let value = secure ? nil : axAttribute(element, kAXValueAttribute) as? String
    if role.count > 64 || title.count > 240 || description.count > 240 || (value?.count ?? 0) > 240 { axSnapshotIncomplete = true }
    let enabled = axAttribute(element, kAXEnabledAttribute) as? Bool ?? true
    let identity = String(CFHash(element))
    var signature: [String: Any] = ["identity": identity, "identifier": axAttribute(element, kAXIdentifierAttribute) as? String ?? "",
        "role": role, "subrole": subrole, "title": String(title.prefix(8192)), "description": String(description.prefix(8192)),
        "value": String((value ?? "").prefix(16_384)), "enabled": enabled]
    var position = CGPoint.zero, size = CGSize.zero
    if let rawPosition = axAttribute(element, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
       AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position) {
        signature["x"] = position.x; signature["y"] = position.y
    }
    if let rawSize = axAttribute(element, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID(),
       AXValueGetValue(rawSize as! AXValue, .cgSize, &size) {
        signature["width"] = size.width; signature["height"] = size.height
    }
    var actions = [String](), nativeActions: CFArray?
    let actionResult = AXUIElementCopyActionNames(element, &nativeActions)
    if actionResult == .cannotComplete || actionResult == .invalidUIElement { axSnapshotIncomplete = true }
    if !secure && actionResult == .success, let names = nativeActions as? [String], names.contains(kAXPressAction) { actions.append("press") }
    var settable: DarwinBoolean = false
    if !secure && ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) &&
       AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue {
        actions.append("set_value")
    }
    signature["actions"] = actions
    let data = (try? JSONSerialization.data(withJSONObject: signature, options: [.sortedKeys])) ?? Data()
    let fingerprint = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let key = path.isEmpty ? "root" : path.map(String.init).joined(separator: ".")
    var result: [String: Any] = ["elementId": key, "path": path, "identity": identity, "fingerprint": fingerprint,
        "role": secure ? "AXSecureTextField" : String(role.prefix(64)), "name": String(name.prefix(240)),
        "enabled": enabled, "actions": secure ? [] : actions]
    if let value = value { result["value"] = String(value.prefix(240)) }
    if !path.isEmpty { result["parentId"] = path.count == 1 ? "root" : path.dropLast().map(String.init).joined(separator: ".") }
    return result
}
func accessibilitySnapshot(_ pid: pid_t, _ frame: CGRect) -> [String: Any] {
    guard AXIsProcessTrusted(), let root = windowElement(pid, frame) else {
        return ["text": "", "tree": ["elements": [], "available": false, "truncated": false]]
    }
    AXUIElementSetMessagingTimeout(root, 0.1)
    axSnapshotIncomplete = false
    var nodes = [[String: Any]](), lines = [String](), truncated = false
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    func visit(_ element: AXUIElement, _ path: [Int]) {
        if path.count > 8 || nodes.count >= 200 || ProcessInfo.processInfo.systemUptime > deadline { truncated = true; return }
        let node = axNode(element, path); nodes.append(node)
        let parts = [node["role"] as? String ?? "", node["name"] as? String ?? "", node["value"] as? String ?? ""].filter { !$0.isEmpty }
        lines.append(parts.joined(separator: " · "))
        for (index, child) in axChildren(element).enumerated() {
            if nodes.count >= 200 || ProcessInfo.processInfo.systemUptime > deadline { truncated = true; break }
            visit(child, path + [index])
        }
    }
    visit(root, [])
    let text = lines.joined(separator: "\n")
    if text.count > 16_000 { truncated = true }
    return ["text": String(text.prefix(16_000)), "tree": ["elements": nodes, "available": true, "truncated": truncated || axSnapshotIncomplete]]
}
func resolveAXElement(_ root: AXUIElement, _ snapshot: [String: Any]) throws -> AXUIElement {
    guard let path = snapshot["path"] as? [Int], path.count <= 8,
          let identity = snapshot["identity"] as? String, let fingerprint = snapshot["fingerprint"] as? String else {
        try fail("控件观察凭据无效，请重新观察", "stale_element")
    }
    var element = root
    for index in path {
        let children = axChildren(element)
        guard index >= 0, index < children.count else { try fail("控件树已改变，请重新观察", "stale_element") }
        element = children[index]
    }
    let current = axNode(element, path)
    guard current["identity"] as? String == identity, current["fingerprint"] as? String == fingerprint else {
        try fail("控件身份或状态已改变，请重新观察", "stale_element")
    }
    return element
}
let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
    "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
    "k": 40, "n": 45, "m": 46, "Enter": 36, "Tab": 48, "Backspace": 51,
    "Escape": 53, "Home": 115, "PageUp": 116, "Delete": 117, "End": 119,
    "PageDown": 121, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126
]
func postKey(_ code: CGKeyCode, _ flags: CGEventFlags, _ pid: pid_t, text: String? = nil) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        try fail("无法创建键盘事件")
    }
    down.flags = flags; up.flags = flags
    if let text = text {
        let units = Array(text.utf16)
        units.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
        }
    }
    inputDispatchStatus = "sent"
    down.postToPid(pid); up.postToPid(pid)
}
@main @MainActor struct Helper {
    static func main() async {
        // This process provides window-bound operations and never owns a UI.
        // Set the policy before any AppKit/ScreenCaptureKit initialization.
        NSApplication.shared.setActivationPolicy(.prohibited)
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count <= 128 * 1024,
                  let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
                try fail("无效请求")
            }
            let result = try await execute(request)
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
        } catch {
            let message = (error as? Failure)?.message ?? error.localizedDescription
            let failure = error as? Failure
            let data = try! JSONSerialization.data(withJSONObject: ["error": message, "errorCode": failure?.code ?? "native_rejected",
                "dispatchStatus": failure?.dispatchStatus ?? inputDispatchStatus])
            FileHandle.standardOutput.write(data)
            exit(1)
        }
    }
    static func execute(_ request: [String: Any]) async throws -> [String: Any] {
        if request["operation"] as? String == "host-approval" {
            guard let backend = request["backendId"] as? String, !backend.isEmpty, backend.count <= 80,
                  backend.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
                try fail("无效的后端身份")
            }
            let context = LAContext()
            defer { context.invalidate() }
            do {
                let reason = "允许 CoworkOS 后端 \(backend) 启用或恢复对所有应用窗口的控制"
                if try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) {
                    return ["approved": true]
                }
            } catch {
                try fail("本机身份验证未通过或已取消", "approval_denied")
            }
            try fail("本机身份验证未通过或已取消", "approval_denied")
        }
        if request["operation"] as? String == "status" {
            let supported: Bool
            if #available(macOS 14.0, *) { supported = true } else { supported = false }
            let blocked = controlBlockReason()
            return ["available": supported, "screenRecording": CGPreflightScreenCaptureAccess(),
                    "accessibility": AXIsProcessTrusted(), "windows": windows(),
                    "controlAvailable": blocked.isEmpty, "secureInput": IsSecureEventInputEnabled(),
                    "postEventAccess": CGPreflightPostEventAccess(),
                    "reason": supported ? blocked : "Computer Use 截图需要 macOS 14 或更高版本"]
        }
        if request["operation"] as? String == "permissions" {
            guard let permission = request["permission"] as? String,
                  ["screenRecording", "accessibility"].contains(permission) else { try fail("无效系统权限请求") }
            if permission == "screenRecording" {
                if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            } else if !AXIsProcessTrusted() {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            } else if !CGPreflightPostEventAccess() {
                _ = CGRequestPostEventAccess()
            }
            // The host reads fresh status before it treats a request as granted.
            return ["requested": true]
        }
        let (app, windowID, frame) = try checkTarget(request)
        if request["operation"] as? String == "observe" {
            guard CGPreflightScreenCaptureAccess() else { try fail("需要屏幕录制权限") }
            guard #available(macOS 14.0, *) else { try fail("需要 macOS 14 或更高版本") }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { $0.windowID == windowID && $0.owningApplication?.processID == app.processIdentifier }) else {
                try fail("目标窗口不可捕获")
            }
            let configuration = SCStreamConfiguration()
            let scale = min(1, 1800 / max(frame.width, frame.height))
            configuration.width = max(1, Int(frame.width * scale))
            configuration.height = max(1, Int(frame.height * scale))
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
                try fail("无法编码截图")
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { try fail("截图编码失败") }
            let accessibility = accessibilitySnapshot(app.processIdentifier, frame)
            return ["width": image.width, "height": image.height, "image": data.base64EncodedString(),
                    "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
                    "accessibilityText": accessibility["text"] ?? "", "accessibility": accessibility["tree"] ?? [:]]
        }
        guard request["operation"] as? String == "act", AXIsProcessTrusted(),
              let action = request["action"] as? [String: Any], let type = action["type"] as? String,
              let captured = request["frame"] as? [String: Any],
              let old = captured["frame"] as? [String: CGFloat],
              old["x"] == frame.minX, old["y"] == frame.minY,
              old["width"] == frame.width, old["height"] == frame.height else {
            try fail("需要辅助功能权限，且窗口位置和尺寸必须与最近观察一致")
        }
        let blocked = controlBlockReason()
        if !blocked.isEmpty { try fail(blocked) }
        let targetElement = windowElement(app.processIdentifier, frame)
        if type == "activate" {
            inputDispatchStatus = "unknown"
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier || app.activate(options: []) else { try fail("无法激活目标应用，请确认桌面已解锁") }
            for _ in 0..<20 {
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { break }
                try await Task.sleep(nanoseconds: 25_000_000)
            }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { try fail("目标应用未获得前台焦点，请重新观察") }
            if let targetElement = targetElement,
               AXUIElementPerformAction(targetElement, kAXRaiseAction as CFString) != .success {
                try fail("无法激活目标窗口")
            }
            inputDispatchStatus = "sent"
            return ["completed": true, "dispatchStatus": "sent"]
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            try fail("目标应用不在前台，请先激活并重新观察")
        }
        let ordered = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
        guard let front = ordered.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier }),
              (front[kCGWindowNumber as String] as? UInt32) == windowID else {
            try fail("目标窗口被同应用的另一个窗口遮挡，请重新选择窗口")
        }
        if let targetElement = targetElement {
            var focused: CFTypeRef?
            guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute as CFString, &focused) == .success,
                  let focused = focused, CFEqual(focused, targetElement) else {
                try fail("目标窗口已失去焦点，请重新激活并观察")
            }
        }
        if type == "press" || type == "set_value" {
            guard let root = targetElement, let snapshot = request["element"] as? [String: Any],
                  snapshot["elementId"] as? String == action["elementId"] as? String else {
                try fail("需要最近观察中的辅助功能控件", "stale_element")
            }
            let element = try resolveAXElement(root, snapshot)
            let current = axNode(element, snapshot["path"] as? [Int] ?? [])
            guard current["enabled"] as? Bool == true, (current["actions"] as? [String] ?? []).contains(type) else {
                try fail("控件未启用或不支持此动作", "element_unavailable")
            }
            try ensureInputTarget(request, app, windowID, frame)
            if type == "press" {
                inputDispatchStatus = "unknown"
                guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
                    try fail("辅助功能按下动作未确认，请重新观察；不能自动重发", "native_action_failed")
                }
            } else {
                guard let value = action["value"] as? String, !value.contains("\0"), value.utf8.count <= 16_384 else { try fail("控件值不合法", "invalid_argument") }
                inputDispatchStatus = "unknown"
                guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else {
                    try fail("辅助功能设置值未确认，请重新观察；不能自动重发", "native_action_failed")
                }
            }
            inputDispatchStatus = "sent"
        } else if type == "click" {
            guard let x = action["x"] as? CGFloat, let y = action["y"] as? CGFloat,
                  let width = captured["width"] as? CGFloat, let height = captured["height"] as? CGFloat,
                  width > 0, height > 0, x >= 0, y >= 0, x < width, y < height,
                  let button = action["button"] as? String, ["left", "right"].contains(button) else { try fail("点击坐标不合法") }
            guard let screen = NSScreen.screens.first else { try fail("没有可用的桌面坐标系") }
            // A window-bound CGEvent uses top-left local coordinates. The helper
            // does not own that NSWindow, so NSEvent.cgEvent only applies the
            // main screen's Y flip; compensate before constructing the event.
            let location = CGPoint(x: x * frame.width / width, y: screen.frame.maxY - y * frame.height / height)
            let right = button == "right"
            // AppKit encodes the receiving window and its local coordinates. Bare
            // CG mouse events posted to a PID arrive with windowNumber=0 and are
            // visible to event monitors without reaching the intended control.
            guard let down = NSEvent.mouseEvent(with: right ? .rightMouseDown : .leftMouseDown, location: location,
                                               modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: Int(windowID), context: nil, eventNumber: 0, clickCount: 1, pressure: 1)?.cgEvent,
                  let up = NSEvent.mouseEvent(with: right ? .rightMouseUp : .leftMouseUp, location: location,
                                             modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                             windowNumber: Int(windowID), context: nil, eventNumber: 0, clickCount: 1, pressure: 0)?.cgEvent else { try fail("无法创建鼠标事件") }
            let expected = CGPoint(x: x * frame.width / width, y: y * frame.height / height)
            guard abs(down.location.x - expected.x) < 0.01, abs(down.location.y - expected.y) < 0.01,
                  abs(up.location.x - expected.x) < 0.01, abs(up.location.y - expected.y) < 0.01 else {
                try fail("系统无法建立目标窗口的点击坐标，请重新观察")
            }
            inputDispatchStatus = "sent"
            down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
        } else if type == "type" {
            guard let text = action["text"] as? String, !text.isEmpty, text.utf8.count <= 16_384 else { try fail("文本不合法") }
            // Keep each Quartz payload small and never split a UTF-16 surrogate pair.
            // Long payloads can be silently ignored by the target's text input system.
            var chunk = "", units = 0
            for scalar in text.unicodeScalars {
                let length = scalar.value > 0xFFFF ? 2 : 1
                if units + length > 20 {
                    try ensureInputTarget(request, app, windowID, frame)
                    try postKey(0, [], app.processIdentifier, text: chunk)
                    try await Task.sleep(nanoseconds: 10_000_000)
                    chunk = ""; units = 0
                }
                chunk.unicodeScalars.append(scalar); units += length
            }
            if !chunk.isEmpty {
                try ensureInputTarget(request, app, windowID, frame)
                try postKey(0, [], app.processIdentifier, text: chunk)
            }
        } else if type == "key" {
            guard let keys = action["keys"] as? [String], keys.count <= 5,
                  let key = keys.first(where: { keyCodes[$0] != nil }), let code = keyCodes[key] else { try fail("按键不合法") }
            var flags: CGEventFlags = []
            if keys.contains("Meta") { flags.insert(.maskCommand) }
            if keys.contains("Control") { flags.insert(.maskControl) }
            if keys.contains("Alt") { flags.insert(.maskAlternate) }
            if keys.contains("Shift") { flags.insert(.maskShift) }
            try postKey(code, flags, app.processIdentifier)
        } else { try fail("不支持的动作") }
        // Allow a bounded drain interval before this short-lived helper exits.
        try await Task.sleep(nanoseconds: 100_000_000)
        return ["completed": true, "dispatchStatus": "sent"]
    }
}

func ensureInputTarget(_ request: [String: Any], _ app: NSRunningApplication, _ windowID: UInt32, _ frame: CGRect) throws {
    let blocked = controlBlockReason()
    if !blocked.isEmpty { try fail(blocked) }
    let (_, currentID, currentFrame) = try checkTarget(request)
    guard currentID == windowID, currentFrame == frame,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        try fail("输入期间目标窗口或前台焦点发生变化，请重新观察；已发送的文本不能自动重试")
    }
    let ordered = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    guard let front = ordered.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier }),
          (front[kCGWindowNumber as String] as? UInt32) == windowID else {
        try fail("输入期间目标窗口被另一个窗口遮挡，请重新观察；已发送的文本不能自动重试")
    }
    if let target = windowElement(app.processIdentifier, frame) {
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let focused = focused, CFEqual(focused, target) else {
            try fail("输入期间窗口失去焦点，请重新观察；已发送的文本不能自动重试")
        }
    }
}
