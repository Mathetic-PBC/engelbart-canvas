import AppKit
import EngelbartCore
import EngelbartUI

// Self-test hooks for headless runs (the cloud runner, mac/scripts/cloud-test.sh), the Swift counterpart of
// scripts/drive.mjs + CDP screenshots. Neither needs Screen Recording or Accessibility permission: pictures are the app's
// own drawing of its windows (cacheDisplay), and the driver acts on the app's own accessibility tree from inside.
//
//   ENGELBART_SNAPSHOT=<dir>    launch, wait until every window has drawn, write <dir>/window-<n>.png for each window and
//                               <dir>/windows.json (frames, titles, phases), then quit with status 0.
//   ENGELBART_DRIVE=<file.json> run the script's steps once every window has drawn, then quit: status 0 when every step
//                               passed, 1 at the first that failed (its message on stderr and in <dir>/drive-report.json).
//                               With ENGELBART_SNAPSHOT too, the final pictures are written as above before quitting;
//                               `snapshot` steps write into that dir (else beside the script).
//   ENGELBART_SELFTEST_TIMEOUT  seconds to wait for the windows to draw (default 20).
//
// A script is a JSON array of steps (or { "steps": [...] }). Views are found by their accessibility identifier, named after
// the Electron data-* attribute they stand for ("settings-gear", "settings-page=model", "directory-gate"…; API.md lists
// them). Steps:
//   { "wait": 300 }                                  milliseconds
//   { "waitFor": "<id>", "timeout": 5000 }           until a view with that identifier exists
//   { "click": "<id>" }                              press it (accessibility press, else a mouse click at its centre)
//   { "click": { "x": 100, "y": 200 } }              a mouse click at a point in the window's content (y down)
//   { "type": "hello" }                              text into the focused field
//   { "key": "Escape" } / { "key": "cmd+shift+n" }   a key press (through the menu's key equivalents and the monitors)
//   { "menu": "File/New Window" }                    a main-menu item by its titles
//   { "action": "find" }                             a WindowAction to the focused window (ActionRouter.swift)
//   { "expect": "<id>" } / { "expectMissing": "<id>" }
//   { "expectTitle": "Fellowship — Engelbart" }      the focused window's title
//   { "window": 1 }                                  later steps act on window n (0-based, in opening order)
//   { "snapshot": "name" }                           name-<n>.png for each window, and name.json

@MainActor
public final class SelfTest {
    public struct Failure: Error, CustomStringConvertible { public let description: String }

    let manager: WindowManager
    let quit: QuitController
    let environment: [String: String]
    var windowIndex: Int? = nil
    var report: [JSONValue] = []

    public init(manager: WindowManager, quit: QuitController, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.manager = manager; self.quit = quit; self.environment = environment
    }

    public var snapshotDir: URL? { environment["ENGELBART_SNAPSHOT"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } }
    public var drivePath: URL? { environment["ENGELBART_DRIVE"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } }
    public var active: Bool { snapshotDir != nil || drivePath != nil }

    /// Starts the run once the app has opened its windows.
    public func start() {
        guard active else { return }
        Task { @MainActor in
            let timeout = Double(environment["ENGELBART_SELFTEST_TIMEOUT"] ?? "") ?? 20
            var status: Int32 = 0
            do {
                try await waitUntilDrawn(timeout: timeout)
                if let drivePath { try await drive(script: drivePath) }
                if let dir = snapshotDir { try snapshot(into: dir, name: "window") }
            } catch {
                status = 1
                FileHandle.standardError.write(Data("[engelbart self-test] \(error)\n".utf8))
                // What was on screen when it failed: the identifiers present, and the pictures.
                report.append(["failed": .string("\(error)"), "present": .array(presentIDs().map { .string($0) })])
                if let dir = snapshotDir { try? snapshot(into: dir, name: "failure") }
            }
            if !report.isEmpty, let dir = snapshotDir ?? drivePath?.deletingLastPathComponent() {
                try? Files.writeJSON(.array(report), to: dir.appendingPathComponent("drive-report.json"))
            }
            let code = status
            quit.finish = { _ in exit(code) }
            if await !quit.request(update: true) { exit(code) }
        }
    }

    /// Every window booted (its root left the blank boot phase) and laid out, then one more turn for SwiftUI to draw.
    func waitUntilDrawn(timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let contexts = manager.registry.all()
            let ready = !contexts.isEmpty && contexts.allSatisfy { ctx in
                guard let model = manager.model(of: ctx) else { return false }
                return model.phase != .boot || !model.error.isEmpty
            }
            if ready { break }
            if Date() > deadline { throw Failure(description: "windows did not draw within \(Int(timeout)) s") }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try await Task.sleep(nanoseconds: 600_000_000) // the rise entrances (≤ 260 ms) and SwiftUI's layout passes
        for ctx in manager.registry.all() { manager.window(of: ctx)?.displayIfNeeded() }
    }

    // MARK: snapshots

    /// `<name>-<n>.png` per window and `<name>s.json` (`windows.json` for the final set).
    public func snapshot(into dir: URL, name: String) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var entries: [JSONValue] = []
        for (index, ctx) in manager.registry.all().enumerated() {
            guard let window = manager.window(of: ctx) else { continue }
            window.displayIfNeeded()
            let file = "\(name)-\(index).png"
            if let png = Self.png(of: window) { try png.write(to: dir.appendingPathComponent(file)) }
            let f = window.frame
            let model = manager.model(of: ctx)
            entries.append([
                "index": .number(Double(index)), "file": .string(file), "title": .string(window.title),
                "frame": ["x": .number(f.minX), "y": .number(f.minY), "width": .number(f.width), "height": .number(f.height)],
                "phase": .string(model?.phase.rawValue ?? ""), "error": .string(model?.error ?? ""),
                "visible": .bool(window.isVisible), "key": .bool(window.isKeyWindow), "fullScreen": .bool(window.isFullScreen),
                "place": ["projectId": ctx.place?.projectId.map { .string($0) } ?? .null, "workspaceId": ctx.place?.workspaceId.map { .string($0) } ?? .null],
                "childWindows": .number(Double(window.childWindows?.count ?? 0)),
            ])
            // Floating panels and tooltips are child windows: drawn beside it.
            for (c, child) in (window.childWindows ?? []).enumerated() where child.isVisible {
                if let png = Self.png(of: child) { try png.write(to: dir.appendingPathComponent("\(name)-\(index)-panel-\(c).png")) }
            }
        }
        try Files.writeJSON(.array(entries), to: dir.appendingPathComponent(name == "window" ? "windows.json" : "\(name).json"))
    }

    /// The window as drawn: its frame view (title bar and traffic lights included) and everything in it.
    public static func png(of window: NSWindow) -> Data? {
        guard let view = window.contentView?.superview ?? window.contentView else { return nil }
        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0, let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return nil }
        view.cacheDisplay(in: bounds, to: rep)
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: the driver

    func drive(script url: URL) async throws {
        let parsed = try JSONValue.parse(try Data(contentsOf: url))
        let steps = parsed.array ?? parsed["steps"]?.array ?? []
        for (n, step) in steps.enumerated() {
            do {
                try await run(step)
                report.append(["step": .number(Double(n)), "ok": true, "do": step])
            } catch {
                report.append(["step": .number(Double(n)), "ok": false, "do": step, "error": .string("\(error)")])
                throw Failure(description: "step \(n) \(step.text()): \(error)")
            }
        }
    }

    var window: EngelbartWindow? {
        let contexts = manager.registry.all()
        if let i = windowIndex { return contexts.indices.contains(i) ? manager.window(of: contexts[i]) : nil }
        return manager.focusedContext.flatMap { manager.window(of: $0) } ?? contexts.first.flatMap { manager.window(of: $0) }
    }

    func run(_ step: JSONValue) async throws {
        if let ms = step["wait"]?.double { try await Task.sleep(nanoseconds: UInt64(ms * 1_000_000)); return }
        if let id = step["waitFor"]?.string {
            let deadline = Date().addingTimeInterval((step["timeout"]?.double ?? 5000) / 1000)
            while find(id) == nil {
                if Date() > deadline { throw Failure(description: "no view \"\(id)\"") }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            return
        }
        if let index = step["window"]?.int { windowIndex = index; return }
        if let target = step["click"] {
            if let id = target.string {
                switch find(id) {
                case .none: throw Failure(description: "no view \"\(id)\"")
                case .view(let view)?:
                    guard let host = view.window else { throw Failure(description: "\"\(id)\" has no window") }
                    // Below the fold of a scroll view: scrolled into sight first, as a person would.
                    if let content = host.contentView, !content.visibleRect.contains(content.convert(view.bounds, from: view)) || view.visibleRect.isEmpty {
                        view.scrollToVisible(view.bounds)
                        try await settle()
                    }
                    let rect = host.convertToScreen(view.convert(view.bounds, to: nil))
                    try click(screenPoint: CGPoint(x: rect.midX, y: rect.midY), in: host)
                case .element(let element)?:
                    if !element.accessibilityPerformPress() {
                        let frame = element.accessibilityFrame()
                        guard let window else { throw Failure(description: "no window") }
                        try click(screenPoint: CGPoint(x: frame.midX, y: frame.midY), in: window)
                    }
                }
            } else if let x = target["x"]?.double, let y = target["y"]?.double {
                guard let window, let content = window.contentView else { throw Failure(description: "no window") }
                let local = content.isFlipped ? CGPoint(x: x, y: y) : CGPoint(x: x, y: content.bounds.height - y)
                try click(screenPoint: window.convertPoint(toScreen: content.convert(local, to: nil)), in: window)
            }
            try await settle(); return
        }
        if let text = step["type"]?.string {
            guard let responder = window?.firstResponder else { throw Failure(description: "nothing has the keyboard") }
            if let client = responder as? NSTextInputClient { client.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0)) }
            else { responder.insertText(text) }
            try await settle(); return
        }
        if let spec = step["key"]?.string {
            guard let window, let event = Self.keyEvent(spec, window: window) else { throw Failure(description: "unknown key \(spec)") }
            NSApp.postEvent(event, atStart: false)
            if let up = Self.keyEvent(spec, window: window, up: true) { NSApp.postEvent(up, atStart: false) }
            try await settle(); return
        }
        if let path = step["menu"]?.string {
            guard let item = Self.menuItem(path) else { throw Failure(description: "no menu item \(path)") }
            guard let menu = item.menu else { throw Failure(description: "menu item \(path) has no menu") }
            menu.performActionForItem(at: menu.index(of: item))
            try await settle(); return
        }
        if let name = step["action"]?.string {
            guard let action = WindowAction(rawValue: name) else { throw Failure(description: "unknown action \(name)") }
            guard let ctx = manager.focusedContext else { throw Failure(description: "no window") }
            if !ctx.actions.send(action) { throw Failure(description: "nothing took \(name)") }
            try await settle(); return
        }
        if let id = step["expect"]?.string { if find(id) == nil { throw Failure(description: "expected \"\(id)\"") }; return }
        if let id = step["expectMissing"]?.string { if find(id) != nil { throw Failure(description: "\"\(id)\" should not be there") }; return }
        if let title = step["expectTitle"]?.string {
            if window?.title != title { throw Failure(description: "title is \"\(window?.title ?? "")\"") }
            return
        }
        if let name = step["snapshot"]?.string {
            let dir = snapshotDir ?? (drivePath?.deletingLastPathComponent() ?? URL(fileURLWithPath: NSTemporaryDirectory()))
            try snapshot(into: dir, name: name); return
        }
        throw Failure(description: "unknown step")
    }

    /// Lets SwiftUI and the run loop take the step in before the next one.
    func settle() async throws { try await Task.sleep(nanoseconds: 150_000_000) }

    enum Found { case view(NSView), element(NSAccessibilityProtocol) }

    /// A view with that identifier in the window (and its floating panels): a `driveID` marker first (SwiftUI builds no
    /// accessibility tree without an accessibility client), else an accessibility element (AppKit views).
    func find(_ id: String) -> Found? {
        guard let window else { return nil }
        let roots: [NSWindow] = [window] + (window.childWindows ?? [])
        if let view = DriveRegistry.view(id, in: roots) { return .view(view) }
        for root in roots {
            if let hit = Self.search(root, id: id, depth: 0) { return .element(hit) }
        }
        return nil
    }

    /// The identifiers on screen now (a failing step's report).
    func presentIDs() -> [String] {
        guard let window else { return [] }
        return DriveRegistry.ids(in: [window] + (window.childWindows ?? []))
    }

    static func search(_ node: Any, id: String, depth: Int) -> NSAccessibilityProtocol? {
        guard depth < 60, let element = node as? NSAccessibilityProtocol else { return nil }
        if element.accessibilityIdentifier() == id { return element }
        for child in element.accessibilityChildren() ?? [] {
            if let hit = search(child, id: id, depth: depth + 1) { return hit }
        }
        return nil
    }

    /// A left click at a screen point, sent to `window` (made key first, as a person's first click would).
    func click(screenPoint: CGPoint, in window: NSWindow) throws {
        if !window.isKeyWindow {
            NSApp.activate(ignoringOtherApps: true)
            if window.canBecomeKey { window.makeKey() } else { window.parent?.makeKeyAndOrderFront(nil) }
        }
        let p = window.convertPoint(fromScreen: screenPoint)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
            // Queued, not sent: a control's mouse-down starts a tracking loop that reads the mouse-up from the queue.
            NSApp.postEvent(event, atStart: false)
        }
    }

    /// "cmd+shift+n", "Escape", "Enter", "a".
    public static func keyEvent(_ spec: String, window: NSWindow, up: Bool = false) -> NSEvent? {
        var parts = spec.split(separator: "+").map(String.init)
        guard let name = parts.popLast() else { return nil }
        var flags: NSEvent.ModifierFlags = []
        for mod in parts {
            switch mod.lowercased() {
            case "cmd", "meta", "command": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "alt", "option", "opt": flags.insert(.option)
            case "ctrl", "control": flags.insert(.control)
            default: return nil
            }
        }
        guard let (code, chars) = keyCode(name) else { return nil }
        let shown = flags.contains(.shift) ? chars.uppercased() : chars
        return NSEvent.keyEvent(with: up ? .keyUp : .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                windowNumber: window.windowNumber, context: nil, characters: shown, charactersIgnoringModifiers: chars,
                                isARepeat: false, keyCode: code)
    }

    /// The ANSI key codes of the keys scripts name.
    public static func keyCode(_ name: String) -> (UInt16, String)? {
        let named: [String: (UInt16, String)] = [
            "Enter": (36, "\r"), "Return": (36, "\r"), "Escape": (53, "\u{1b}"), "Tab": (48, "\t"), "Backspace": (51, "\u{7f}"),
            "Delete": (117, "\u{f728}"), "Space": (49, " "), "ArrowUp": (126, "\u{f700}"), "ArrowDown": (125, "\u{f701}"),
            "ArrowLeft": (123, "\u{f702}"), "ArrowRight": (124, "\u{f703}"), "Home": (115, "\u{f729}"), "End": (119, "\u{f72b}"),
        ]
        if let hit = named[name] { return hit }
        let letters: [Character: UInt16] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
                                            "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
                                            "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
                                            "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
                                            ".": 47, "`": 50]
        guard name.count == 1, let c = name.lowercased().first, let code = letters[c] else { return nil }
        return (code, String(c))
    }

    /// "File/New Window" → that item of the main menu.
    public static func menuItem(_ path: String, in bar: NSMenu? = NSApplication.shared.mainMenu) -> NSMenuItem? {
        var menu = bar
        var item: NSMenuItem?
        for title in path.split(separator: "/").map(String.init) {
            item = menu?.items.first { $0.title == title }
            menu = item?.submenu
        }
        return item
    }
}
