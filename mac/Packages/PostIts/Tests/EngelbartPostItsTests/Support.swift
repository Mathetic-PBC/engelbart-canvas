import AppKit
import XCTest
import EngelbartCore
import EngelbartUI
import EngelbartStore
import EngelbartBuild
@testable import EngelbartPostIts

final class FakeData: PostItsData {
    var dirs: [String: String] = [:]
    var notes: [(project: String, name: String, text: String)] = []
    var names: [String: String] = [:]
    func projectDir(_ projectId: String) async throws -> String {
        guard let dir = dirs[projectId] else { throw GeometryError("Unknown project") }
        return dir
    }
    func createNote(_ projectId: String, name: String, text: String) async throws -> (id: String, name: String) {
        notes.append((projectId, name, text))
        let dir = try await projectDir(projectId)
        try text.write(toFile: (dir as NSString).appendingPathComponent("\(name).md"), atomically: true, encoding: .utf8)
        return (IDs.new(), name)
    }
    func workspaceName(_ projectId: String, _ workspaceId: String) async -> String? { names[workspaceId] }
}

final class FakeBuild: PostItsBuild {
    var models: JSONValue = BuildChoices.defaults.json
    var preflight: JSONValue = ["ok": true, "target": ["name": "engelbart"]]
    var list: [JSONValue] = []
    var started: [JSONValue] = []
    var remembered: [String] = []
    var stopped: [String] = []
    var discarded: [String] = []
    var promoted: [(id: String, workspace: String, choice: JSONValue?)] = []
    var promoteResult: JSONValue = .null
    var startError: Error?
    var askedModels: [String] = []
    func buildModels(_ place: String) async throws -> JSONValue { askedModels.append(place); return models }
    func rememberModelChoice(_ place: String, provider: String, model: String, effort: String) async throws { remembered.append("\(place):\(provider):\(model):\(effort)") }
    func buildPreflight(_ projectId: String, _ target: JSONValue?) async throws -> JSONValue { preflight }
    func buildStart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue {
        if let startError { throw startError }
        started.append(input)
        return ["id": "abcdef0123", "projectId": .string(projectId), "kind": "quick", "status": "queued", "postItId": input["postItId"] ?? .null,
                "provider": input["provider"] ?? .null, "model": input["model"] ?? .null, "effort": input["effort"] ?? .null]
    }
    func buildList(_ projectId: String) async throws -> [JSONValue] { list }
    func buildStop(_ projectId: String, _ id: String) async throws -> Bool { stopped.append(id); return true }
    func buildDiscard(_ projectId: String, _ id: String) async throws -> JSONValue { discarded.append(id); return ["id": .string(id), "projectId": .string(projectId), "status": "discarded"] }
    func buildPromote(_ projectId: String, _ id: String, _ workspaceId: String, choice: JSONValue?) async throws -> JSONValue {
        promoted.append((id, workspaceId, choice))
        return promoteResult
    }
}

/// Post-its in an offscreen window (made with defer: false, never ordered front), over a project in a temporary folder,
/// with synthesized events and pixel reads.
@MainActor
class PostItsTestCase: XCTestCase {
    var window: NSWindow!
    var controller: PostItsController!
    var data: FakeData!
    var build: FakeBuild!
    var events: EventHub!
    var visibility: PostItsVisibility!
    var defaults: UserDefaults!
    var peers: PostItPeers!
    var dir = ""
    let project = "11111111-1111-4111-8111-111111111111"
    var opened: [(String, String, String)] = []
    var links: [String] = []
    var errors: [String] = []
    var versions: [(String, JSONValue)] = []
    var clock = Date()

    override func setUp() async throws {
        try await super.setUp()
        _ = NSApplication.shared
        Fonts.register()
        dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("engelbart-post-its-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        data = FakeData()
        data.dirs[project] = dir
        build = FakeBuild()
        events = EventHub()
        defaults = UserDefaults(suiteName: "postits-\(UUID().uuidString)")!
        visibility = PostItsVisibility(defaults: defaults)
        peers = PostItPeers()
        (window, controller) = makeWindow()
    }

    override func tearDown() async throws {
        for w in extraWindows { w.1.dispose(); w.0.close() }
        extraWindows = []
        controller?.dispose()
        window?.close()
        NotesDB.close(projectDir: dir)
        try? FileManager.default.removeItem(atPath: dir)
        window = nil; controller = nil
        try await super.tearDown()
    }

    var extraWindows: [(NSWindow, PostItsController)] = []

    func makeWindow(width: CGFloat = 1200, height: CGFloat = 800) -> (NSWindow, PostItsController) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        w.contentView = content
        var ctx = PostItsContext(data: data, build: build)
        ctx.events = events
        ctx.peers = peers
        ctx.visibility = visibility
        ctx.pickMemory = PickMemory(defaults: defaults)
        ctx.now = { [unowned self] in self.clock }
        ctx.openNote = { [unowned self] p, id, name in self.opened.append((p, id, name)) }
        ctx.openLink = { [unowned self] url in self.links.append(url) }
        ctx.onError = { [unowned self] e in self.errors.append(errorText(e)) }
        ctx.goToVersion = { [unowned self] ws, v in self.versions.append((ws, v)) }
        ctx.workspaces = { [WorkspaceEntry(id: "w1", name: "Thesis"), WorkspaceEntry(id: "w2", name: "Figures", above: ["Thesis"])] }
        ctx.hereWorkspaceId = { "w2" }
        let c = PostItsController(context: ctx)
        c.attach(to: content)
        return (w, c)
    }

    /// Waits on the main actor, letting its tasks, timers and queued blocks run (a nested run loop would not: the test
    /// itself is a main-queue job).
    func wait(_ seconds: Double = 3, until done: @escaping () -> Bool) async {
        let end = Date().addingTimeInterval(seconds)
        while !done() && Date() < end { try? await Task.sleep(nanoseconds: 10_000_000) }
    }
    func wait(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

    var db: NotesDB.PostIts { try! NotesDB.open(projectDir: dir).postIts }
    func seed(_ text: String, nx: Double = 0.2, ny: Double = 0.2, width: Double = 260, height: Double = 260, z: Double = 1) throws -> String {
        let id = IDs.new()
        try db.create(id: id, PostItValues(text: text, nx: nx, ny: ny, width: width, height: height, z: z))
        return id
    }

    // Events, in the window's coordinates; points given in the overlay's (y down).
    func windowPoint(_ p: CGPoint, in c: PostItsController? = nil) -> NSPoint { (c ?? controller).overlay.convert(p, to: nil) }
    func mouse(_ type: NSEvent.EventType, _ p: CGPoint, window w: NSWindow? = nil, controller c: PostItsController? = nil) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: windowPoint(p, in: c), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: (w ?? window).windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }
    func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = [], window w: NSWindow? = nil) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: (w ?? window).windowNumber, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }
    /// A press, drag and release as AppKit delivers them: the view the press hit gets the rest.
    func drag(from a: CGPoint, to b: CGPoint, steps: Int = 4, release: Bool = true, c: PostItsController? = nil, w: NSWindow? = nil) {
        let c = c ?? controller!
        guard let target = c.overlay.hitTest(c.overlay.superview!.convert(c.overlay.convert(a, to: nil), from: nil)) else { XCTFail("nothing under \(a)"); return }
        target.mouseDown(with: mouse(.leftMouseDown, a, window: w, controller: c))
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            target.mouseDragged(with: mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), window: w, controller: c))
        }
        if release { target.mouseUp(with: mouse(.leftMouseUp, b, window: w, controller: c)) }
    }
    func hit(_ p: CGPoint, c: PostItsController? = nil) -> NSView? {
        let c = c ?? controller!
        return c.overlay.hitTest(c.overlay.superview!.convert(c.overlay.convert(p, to: nil), from: nil))
    }

    func activate(_ c: PostItsController? = nil) async {
        await (c ?? controller).activate(project)
    }

    /// A view's picture: its drawing into its layer, then the layer tree rendered into an sRGB bitmap.
    struct Pixels {
        let w: Int, h: Int, data: [UInt8]
        func rgb(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
            let i = (min(h - 1, max(0, y)) * w + min(w - 1, max(0, x))) * 4
            return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]))
        }
    }
    func pixels(_ v: NSView) -> Pixels {
        v.layoutSubtreeIfNeeded()
        v.display()
        func displayAll(_ l: CALayer) { l.displayIfNeeded(); l.sublayers?.forEach(displayAll) }
        let layer = v.layer!
        displayAll(layer)
        let w = max(1, Int(layer.bounds.width.rounded())), h = max(1, Int(layer.bounds.height.rounded()))
        var data = [UInt8](repeating: 255, count: w * h * 4)
        data.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            layer.render(in: ctx)
        }
        return Pixels(w: w, h: h, data: data)
    }
    func color(_ p: Pixels, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) { p.rgb(x, y) }
    func near(_ a: (r: Int, g: Int, b: Int), _ hex: String, _ tolerance: Int = 6, file: StaticString = #filePath, line: UInt = #line) {
        let c = NSColor(hex: hex).usingColorSpace(.sRGB)!
        let b = (Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
        XCTAssertTrue(abs(a.r - b.0) <= tolerance && abs(a.g - b.1) <= tolerance && abs(a.b - b.2) <= tolerance, "\(a) is not \(hex)", file: file, line: line)
    }
}
