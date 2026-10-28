import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// The IPC surface (ipc.cjs connect-* / import-*, index.cjs's wiring) through ConnectEngine, with the fakes Electron's
/// e2e runs use (ENGELBART_CONNECT_FAKE): events under their channel names, the offer, the memory, the flow, the disk
/// access granted at launch, a session started and listed, quit and test-mode reset.
@MainActor
final class EngineTests: XCTestCase {
    func engine(_ home: TempDir, _ root: TempDir, env extra: [String: String] = [:], posted: Box<[(String, JSONValue)]>) -> ConnectEngine {
        var host = ConnectEngine.Host(store: FakeStore(root: root.path), homeDir: home.path, appSupportDir: TempDir.make("support"))
        host.env = ["ENGELBART_CONNECT_FAKE": "1", "ENGELBART_CONNECT_FAKE_MS": "5", "ENGELBART_HEADLESS": "1"].merging(extra) { _, b in b }
        host.post = { channel, value in posted.set(posted.get() + [(channel, value)]) }
        return ConnectEngine(host)
    }

    func testOfferMemoryFlowAndInputs() async throws {
        let home = TempDir(), root = TempDir()
        let posted = Box<[(String, JSONValue)]>([])
        let e = engine(home, root, posted: posted)
        let hoisted1 = await e.offer()
        XCTAssertEqual(hoisted1, ["show": true])
        let hoisted2 = await e.offerSeen("started")
        XCTAssertTrue(hoisted2)
        let hoisted3 = await e.offer()
        XCTAssertEqual(hoisted3, ["show": false])
        XCTAssertEqual(Files.readJSON(root.url.appendingPathComponent(".connect/offer.json"))?["how"]?.string, "started")
        let hoisted4 = await engine(home, TempDir(), env: ["ENGELBART_CONNECT_OFFER": "off"], posted: posted).offer()
        XCTAssertEqual(hoisted4, ["show": false])
        let hoisted5 = await e.memoryInfo()["exists"]
        XCTAssertEqual(hoisted5, false)
        root.write("MEMORY.md", "# Memory\n")
        let memory = await e.memoryInfo()
        XCTAssertEqual(memory["exists"], true); XCTAssertEqual(memory["bytes"]?.int, 9)
        let hoisted6 = await e.importFlow()
        XCTAssertEqual(hoisted6, .null)
        let hoisted7 = try await e.importFlowSave(["step": "tools"])
        XCTAssertTrue(hoisted7)
        let hoisted8 = await e.importFlow()
        XCTAssertEqual(hoisted8, ["step": "tools"])
        let hoisted9 = try await e.importFlowSave(nil)
        XCTAssertTrue(hoisted9)
        let hoisted10 = await e.importFlow()
        XCTAssertEqual(hoisted10, .null)
        do { _ = try await e.importFlowSave("x"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "flow is invalid") }
        do { _ = try await e.importProviderRemember("x"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "provider is invalid") }
        XCTAssertThrowsError(try e.answer("", ["text": "x"])) { XCTAssertEqual(($0 as? ConnectError)?.message, "import id is invalid") }
        XCTAssertThrowsError(try e.state(String(repeating: "x", count: 65))) { XCTAssertEqual(($0 as? ConnectError)?.message, "import id is invalid") }
        do { _ = try await e.start("x"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "choices is invalid") }
        do { _ = try await e.foldersAsk(Array(repeating: "Desktop", count: 41)); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "ids must be a list of folder ids") }
        // The fakes: providers 'both' with the connect fake, browser agents 'none'.
        let providers = await e.importProviders(fresh: true)
        XCTAssertEqual(providers["providers"]?.array?.map { JS.string($0["subscription"]) }, ["max", "pro"])
        let hoisted11 = await e.importBrowserAgents(provider: "anthropic")["available"]
        XCTAssertEqual(hoisted11, false)
        let hoisted12 = try await e.importBrowserAgentsAnswer("allowed")
        XCTAssertEqual(hoisted12, "allowed")
        XCTAssertEqual(e.providersList().count, 2)
        let hoisted13 = await e.connectorsList().map { JS.string($0["app"]) }
        XCTAssertEqual(hoisted13, Connectors.order)
        XCTAssertTrue(e.connectorCancel("Granola"))
    }

    func testDetectAndDiskAccessAtLaunch() async throws {
        let home = TempDir(), root = TempDir()
        home.mkdir(".claude/projects")
        home.write("Library/Application Support/com.apple.TCC/TCC.db", "db")
        home.mkdir("Desktop"); home.mkdir("Documents")
        let apps = home.mkdir("Apps"); home.mkdir("Apps/Notion.app")
        let posted = Box<[(String, JSONValue)]>([])
        let e = engine(home, root, env: ["ENGELBART_CONNECT_APPLICATIONS": apps], posted: posted)
        let found = await e.detect()
        XCTAssertEqual(found["platform"]?.string, "darwin")
        XCTAssertEqual(found["apps"]?["Claude Code"]?["found"], true)
        XCTAssertEqual(found["apps"]?["Notion"]?["where"]?.string, "on this Mac")
        // Full Disk Access granted: every folder macOS guards written as allowed for this data root.
        let asked = await e.foldersAsked()
        XCTAssertEqual(asked["Desktop"], "allowed"); XCTAssertEqual(asked["Documents"], "allowed")
        XCTAssertEqual(e.importDiskAccess()["granted"], true)
        let hoisted14 = await e.connectSignedIn()
        XCTAssertEqual(hoisted14, [])
        let tree = await e.importObsidianTree()
        XCTAssertEqual(tree["vaults"], [])
    }

    func testASessionThroughTheEngine() async throws {
        let home = TempDir(), root = TempDir()
        home.write("Vault/.obsidian/app.json", "{}"); home.write("Vault/a.md", "A")
        let posted = Box<[(String, JSONValue)]>([])
        let e = engine(home, root, posted: posted)
        let started = try await e.start(["sources": ["sites": ["on": true]], "provider": "anthropic"])
        let id = JS.string(started["id"])
        let opened = await eventually(10) { posted.get().contains { $0.0 == "engelbart:connect" && JS.string($0.1["id"]) == id } }
        XCTAssertTrue(opened, "engelbart:connect sent")
        let listed = await e.list()
        XCTAssertTrue(listed.contains { JS.string($0["id"]) == id })
        XCTAssertEqual(try e.minimize(id, true)["minimized"], true)
        e.suspendAll()
        XCTAssertEqual(Files.readJSON(root.url.appendingPathComponent(".connect/\(id)/session.json"))?["id"]?.string, id)
        e.afterTestReset(dataRoot: root.path)
        XCTAssertThrowsError(try e.state(id), "forgotten: read again from disk only by list()")
        let again = await e.list()
        XCTAssertTrue(again.contains { JS.string($0["id"]) == id }, "resumed from what was saved")
        _ = try e.stop(id)
        XCTAssertTrue(try e.dismiss(id))
        // The trace window opens on the trace kept in this data root.
        XCTAssertTrue(e.importTraceOpen())
        XCTAssertTrue(e.traceWindow.isOpen())
        e.traceWindow.window?.close()
    }
}
