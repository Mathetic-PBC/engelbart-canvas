import XCTest
import WebKit
import EngelbartCore
@testable import EngelbartConnect

/// The onboarding backends (provider-connect.test.cjs, onboarding-round3.test.cjs, connect-onboarding-beta.test.cjs):
/// providers from the tool records and the CLIs' own answers, the browser picked and remembered, browser agents, Full Disk
/// Access, discovery in the background with the fake agents, the agent trace and its window.
@MainActor
final class OnboardingTests: XCTestCase {
    func prefs(_ root: TempDir) -> OnboardingPrefs { let p = root.path; return OnboardingPrefs(dataRoot: { p }) }

    /// A Codex sign-in file whose id token says the ChatGPT plan.
    func codexAuth(_ home: TempDir, plan: String) {
        let claims = Data(#"{"https://api.openai.com/auth":{"chatgpt_plan_type":"\#(plan)"}}"#.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        home.write(".codex/auth.json", #"{"auth_mode":"chatgpt","tokens":{"id_token":"x.\#(claims).y"}}"#)
    }

    func testProvidersFromRecordsAndTheCLIs() async throws {
        XCTAssertEqual(Providers.claudeAuth(#"{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}"#)?.plan, "max")
        XCTAssertEqual(Providers.claudeAuth(#"{"loggedIn": true, "authMethod": "console"}"#)?.loggedIn, true)
        XCTAssertNil(Providers.claudeAuth(#"{"loggedIn": true, "authMethod": "console"}"#)?.plan ?? nil)
        XCTAssertEqual(Providers.claudeAuth(#"{"loggedIn": false}"#)?.loggedIn, false)
        XCTAssertNil(Providers.claudeAuth(""))
        XCTAssertEqual(Providers.stateOf(.init(installed: false, status: "installing", busyAction: "install"), signedIn: false), "connecting")
        XCTAssertEqual(Providers.stateOf(.init(installed: true, status: "signed-out", busyAction: "sign-in"), signedIn: false), "signing-in")
        XCTAssertEqual(Providers.stateOf(.init(installed: true, status: "ready", busyAction: "check"), signedIn: true), "ready")
        let home = TempDir(), root = TempDir()
        codexAuth(home, plan: "plus")
        XCTAssertEqual(Providers.codexPlan(codexHome: home.url.appendingPathComponent(".codex").path), "plus")
        // A check that could not tell (signedIn nil) with Claude Code saying signed out: not ready; Codex signed in with Plus picked.
        let records: [String: Providers.ToolRecord] = ["claude": .init(installed: true, status: "ready", signedIn: nil, path: "/x/claude"), "codex": .init(installed: true, status: "ready", signedIn: nil)]
        let asked = Box<[String]>([])
        let p = Providers(records: { records }, prefs: prefs(root), homeDir: home.path, env: [:], fake: "", claudeStatus: { path in asked.set(asked.get() + [path]); return #"{"loggedIn": false}"# },
                          check: { clis in asked.set(asked.get() + clis) })
        let out = await p.status(fresh: true)
        XCTAssertEqual(out["decision"]?["pick"]?.string, "openai", out.text())
        XCTAssertEqual(out["providers"]?[0]?["signedIn"], false)
        XCTAssertEqual(out["providers"]?[0]?["state"]?.string, "not-connected")
        XCTAssertEqual(out["providers"]?[1]?["subscription"]?.string, "plus")
        XCTAssertEqual(asked.get(), ["/x/claude"])
        _ = await p.status()
        XCTAssertEqual(asked.get().count, 1, "a minute's cache")
        _ = await p.recheck("anthropic")
        XCTAssertTrue(asked.get().contains("claude"), "its CLI checked again")
        _ = try await p.remember("anthropic")
        XCTAssertEqual(prefs(root).get()["provider"]?.string, "anthropic")
        do { _ = try await p.remember("nope"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "provider is invalid") }
        let none = Providers(records: { [:] }, prefs: prefs(TempDir()), homeDir: TempDir().path, env: [:], fake: "")
        let nothing = await none.status(fresh: true)
        XCTAssertEqual(nothing["decision"]?["setup"], true)
        XCTAssertEqual(nothing["decision"]?["pick"], .null)
        let fake = await Providers(records: { [:] }, prefs: prefs(TempDir()), homeDir: "/", env: [:], fake: "both").status()
        XCTAssertEqual(fake["providers"]?.array?.map { JS.string($0["subscription"]) }, ["max", "pro"])
        let ready = await p.ready("openai")
        XCTAssertTrue(ready)
    }

    func testPrefsAndBrowsers() async throws {
        let root = TempDir()
        let pr = prefs(root)
        try pr.set(["provider": "openai", "browser": "chrome", "profile": "Profile 1", "keychain": "allowed", "browserAgents": "nope", "junk": 1, "flow": ["step": 2]])
        XCTAssertEqual(pr.get(), ["provider": "openai", "browser": "chrome", "profile": "Profile 1", "keychain": "allowed", "flow": ["step": 2]])
        try pr.set(["profile": .null, "provider": "x"])
        XCTAssertNil(pr.get()["profile"]); XCTAssertNil(pr.get()["provider"])
        XCTAssertEqual((try? FileManager.default.attributesOfItem(atPath: root.url.appendingPathComponent(".connect/onboarding.json").path))?[.posixPermissions] as? Int, 0o600)
        // Browsers: installed ones only, the default first; a pick and its profile remembered; Allow asks macOS at once.
        let p2 = prefs(TempDir())
        let unlocked = Box<[String]>([])
        let browsers = Browsers(installed: { bundles in Dictionary(uniqueKeysWithValues: bundles.map { ($0, $0 == "com.google.Chrome" || $0 == "com.brave.Browser") }) }, defaultName: { "Brave Browser" }, prefs: p2, override: nil,
                                profilesOf: { id in id == "chrome" ? [.init(id: "Default", name: "Me"), .init(id: "Profile 1", name: "Work")] : [] },
                                unlock: { id in unlocked.set(unlocked.get() + [id]); return id == "brave" ? ["keychain": "refused", "browser": "Brave"] : ["keychain": "allowed"] })
        let list = await browsers.list()
        XCTAssertEqual(list["browsers"]?.array?.map { JS.string($0["id"]) }, ["brave", "chrome"])
        XCTAssertEqual(list["defaultId"]?.string, "brave"); XCTAssertEqual(list["chosenId"]?.string, "brave")
        do { _ = try await browsers.choose("firefox"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "Firefox is not installed") }
        _ = try await browsers.choose("chrome")
        let chosen = try await browsers.chooseProfile("chrome", "Profile 1")
        XCTAssertEqual(chosen["chosenProfile"]?.string, "Profile 1")
        do { _ = try await browsers.chooseProfile("chrome", "Profile 9"); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "Chrome has no such profile") }
        XCTAssertEqual(browsers.preferredName(), "Chrome")
        let allowed = try await browsers.setKeychain("allowed")
        XCTAssertEqual(allowed, ["keychain": "allowed"]); XCTAssertEqual(unlocked.get(), ["chrome"])
        _ = try await browsers.choose("brave")
        XCTAssertNil(p2.get()["profile"], "another browser: its profile forgotten")
        let refused = try await browsers.setKeychain("allowed")
        XCTAssertEqual(refused["keychain"]?.string, "refused")
        let declined = try await browsers.setKeychain("declined")
        XCTAssertEqual(declined, ["keychain": "declined"])
        do { _ = try await browsers.setKeychain("maybe"); XCTFail() } catch {}
        let stand = Browsers(installed: { _ in [:] }, defaultName: { "" }, prefs: prefs(TempDir()), override: ["firefox", "nope", "chrome"])
        let standList = await stand.list()
        XCTAssertEqual(standList["browsers"]?.array?.map { JS.string($0["id"]) }, ["firefox", "chrome"])
    }

    func testBrowserAgentsAndDiskAccess() throws {
        let home = TempDir()
        let support = "Library/Application Support/Google/Chrome"
        home.mkdir("\(support)/Default/Extensions/\(BrowserAgents.claudeExtension)")
        let p = prefs(TempDir())
        let agents = BrowserAgents(homeDir: home.path, env: [:], prefs: p, fake: "")
        XCTAssertEqual(agents.status(provider: "anthropic").available, false, "no messaging host registered")
        home.write("\(support)/NativeMessagingHosts/\(BrowserAgents.hosts["anthropic"]!)", "{}")
        var s = agents.status(provider: "anthropic")
        XCTAssertTrue(s.available); XCTAssertEqual(s.browser?.name, "Chrome"); XCTAssertTrue(s.ask); XCTAssertFalse(s.use)
        try agents.consent("allowed")
        s = agents.status(provider: "anthropic")
        XCTAssertFalse(s.ask); XCTAssertTrue(s.use)
        home.write(".claude.json", #"{"claudeInChromeDefaultEnabled": true}"#)
        XCTAssertTrue(agents.allowedByCli("anthropic"))
        XCTAssertThrowsError(try agents.consent("maybe"))
        XCTAssertEqual(agents.status(provider: "openai").why, "Codex's Chrome plugin is not installed")
        XCTAssertEqual(agents.status(provider: nil).why, "No provider yet")
        XCTAssertFalse(BrowserAgents(homeDir: home.path, env: [:], prefs: p, fake: "none").status(provider: "anthropic").available)
        XCTAssertEqual(BrowserAgents.readCodexConfig("[mcp_servers.\"x\"]\nenabled = false\n[plugins.\"chrome@openai-bundled\"]\nenabled = false # off").plugins["chrome@openai-bundled"], false)
        XCTAssertEqual(BrowserAgents.readCodexConfig("[mcp_servers.\"x\"]\nenabled = false").servers.first?.enabled, false)
        // Full Disk Access: read from whether TCC.db can be read; a stand-in answers for the tests.
        XCTAssertEqual(DiskAccess(homeDir: home.path, fake: "granted").status()["granted"], true)
        XCTAssertEqual(DiskAccess(homeDir: home.path, fake: "denied").status()["granted"], false)
        XCTAssertEqual(DiskAccess(homeDir: home.path).status()["granted"], false, "no TCC.db to read")
        home.write("Library/Application Support/com.apple.TCC/TCC.db", "db")
        XCTAssertEqual(DiskAccess(homeDir: home.path).status()["granted"], true)
        XCTAssertEqual(DiskAccess.probeFile("/Users/x"), "/Users/x/Library/Application Support/com.apple.TCC/TCC.db")
    }

    func discovery(_ root: TempDir, home: TempDir, providers: Providers, agents: ConnectAgents = FakeAgents(delayMs: 1, env: [:]), states: Box<[JSONValue]> = Box([])) -> Discovery {
        var d = Discovery.Deps(agents: agents, store: FakeStore(root: root.path), homeDir: home.path, providers: providers, prefs: prefs(root))
        d.env = [:]
        d.notify = { states.set(states.get() + [$0]) }
        return Discovery(d)
    }

    func testDiscoveryProjectsAndTools() async throws {
        let root = TempDir(), home = TempDir()
        home.mkdir("study/.git"); home.write("study/.git/HEAD", "ref: refs/heads/main\n"); home.write("study/README.md", "# Help-seeking study\n")
        let none = Providers(records: { [:] }, prefs: prefs(root), homeDir: home.path, env: [:], fake: "none")
        let waiting = await discovery(root, home: home, providers: none).startProjects(provider: "anthropic", again: true)
        XCTAssertEqual(waiting["projects"]?["status"]?.string, "waiting-provider")
        let states = Box<[JSONValue]>([])
        let both = Providers(records: { [:] }, prefs: prefs(root), homeDir: home.path, env: [:], fake: "both")
        let d = discovery(root, home: home, providers: both, states: states)
        _ = await d.startProjects(provider: "anthropic")
        let doneProjects = await eventually(10) { await d.state()["projects"]?["status"]?.string == "done" }
        let v1 = await d.state()
        XCTAssertTrue(doneProjects, (v1).text())
        let projects = await d.state()["projects"]?["projects"]?.array ?? []
        XCTAssertFalse(projects.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.url.appendingPathComponent(".connect/discovery.json").path))
        XCTAssertFalse(states.get().isEmpty, "engelbart:discovery sent")
        _ = await d.startTools(provider: "openai")
        let doneTools = await eventually(10) { await d.state()["tools"]?["status"]?.string == "done" }
        let v2 = await d.state()
        XCTAssertTrue(doneTools, (v2).text())
        // The fake's extra "Linear" is a catalog tool now (2026-10-16): counted as Linear, not as an extra.
        let v3 = await d.state()["tools"]?["results"]
        XCTAssertEqual(v3?["additional"], [])
        XCTAssertEqual(v3?["tools"]?.array?.first { $0["id"]?.string == "Linear" }?["method"]?.string, "agent", "the fake answered for every catalog tool in tools; its extra is not added again")
        // forget: read again from that root; the root wiped, idle again.
        try FileManager.default.removeItem(at: root.url.appendingPathComponent(".connect"))
        d.forget(root.path)
        let v4 = await d.state()["projects"]?["status"]?.string
        XCTAssertEqual(v4, "idle")
        _ = await d.reset()
        _ = await d.stop()
    }

    func testDiscoveryFailureNamesTheProvider() async throws {
        final class Failing: ConnectAgents, @unchecked Sendable { let message: String; init(_ m: String) { message = m }
            func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput { throw ConnectError("failed", message) } }
        let root = TempDir(), home = TempDir()
        home.mkdir("study/.git"); home.write("study/.git/HEAD", "ref: refs/heads/main\n"); home.write("study/README.md", "# Study\n")
        let checks = Box<[String]>([])
        let providers = Providers(records: { ["claude": .init(installed: true, status: "ready", signedIn: true, path: "/c")] }, prefs: prefs(root), homeDir: home.path, env: [:], fake: "",
                                  claudeStatus: { _ in #"{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}"# }, check: { checks.set(checks.get() + $0) })
        let d = discovery(root, home: home, providers: providers, agents: Failing("Not logged in · Please run /login"))
        _ = await d.startProjects(provider: "anthropic")
        let settled = await eventually(10) { await d.state()["projects"]?["status"]?.string == "failed" }
        let v5 = await d.state()
        XCTAssertTrue(settled, (v5).text())
        let s = await d.state()["projects"]
        XCTAssertEqual(s?["connect"]?.string, "anthropic"); XCTAssertEqual(s?["error"]?.string, "Not logged in · Please run /login")
        let rechecked = await eventually(5) { checks.get().contains("claude") }
        XCTAssertTrue(rechecked)
        let plain = discovery(TempDir(), home: home, providers: providers, agents: Failing("The model returned no text."))
        _ = await plain.startProjects(provider: "anthropic")
        _ = await eventually(10) { await plain.state()["projects"]?["status"]?.string == "failed" }
        let v6 = await plain.state()["projects"]?["connect"]
        XCTAssertEqual(v6, nil)
    }

    func testAssistantProjectsAnswers() {
        XCTAssertTrue(AssistantProjects.atSignIn("https://chatgpt.com/auth/login"))
        XCTAssertFalse(AssistantProjects.atSignIn("https://chatgpt.com/c/123"))
        let read = AssistantProjects.readAnswer(#"```json\#n{"projects":[{"title":"Study","description":"An RCT."},{"title":""}]}\#n```"#)
        XCTAssertEqual(read.projects.map(\.title), ["Study"])
        XCTAssertEqual(AssistantProjects.readAnswer("I can't see your past chats.").projects.count, 0)
        let merged = AssistantProjects.mergeProjects([[.init(id: "a", title: "Study"), .init(id: "b", title: "Launch")], [.init(id: "c", title: "study"), .init(id: "d", title: "Reading")]], existing: ["Launch"])
        XCTAssertEqual(merged.map(\.title), ["Study", "Reading"])
        XCTAssertEqual(AssistantProjects.answerIn([Readers.Turn(role: "user", text: "Q?"), Readers.Turn(role: "assistant", text: "A.")], question: "Q?"), "A.")
    }

    func testTraceKeepsTurnsAndItsWindowOpens() async throws {
        let root = TempDir()
        let sent = Box<[JSONValue]>([])
        let trace = Trace(dataRoot: { root.path }, notify: { sent.set(sent.get() + [$0]) })
        XCTAssertEqual(Trace.cut("short"), "short")
        let cut = Trace.cut(String(repeating: "a", count: 1000), 200)
        XCTAssertTrue(cut.contains("characters left out of the trace"))
        let agents = trace.wrap(FakeAgents(delayMs: 0, env: [:]))
        _ = try await agents.turn(AgentTurnInput(choice: ConnectModels.choice("anthropic", models: nil), kind: "memory", system: "SYS", message: "MSG", meta: AgentMeta(kind: "memory", sessionId: "s1")))
        let listed = trace.list()
        XCTAssertFalse(listed.isEmpty)
        XCTAssertTrue(listed.contains { JS.string($0["system"]).contains("SYS") || JS.string($0["message"]).contains("MSG") }, listed.map { $0.text() }.joined())
        let day = String(Time.iso().prefix(10))
        let file = root.url.appendingPathComponent(".connect/trace/\(day).jsonl").path
        XCTAssertTrue(FileManager.default.fileExists(atPath: file))
        XCTAssertEqual((try? FileManager.default.attributesOfItem(atPath: file))?[.posixPermissions] as? Int, 0o600)
        XCTAssertFalse(sent.get().isEmpty)
        _ = trace.event(text: "hello")
        let window = TraceWindow(trace: trace, traceDir: { root.url.appendingPathComponent(".connect/trace") })
        XCTAssertTrue(window.open())
        XCTAssertTrue(window.isOpen())
        window.send(["id": "x", "kind": "log", "text": "live"])
        window.window?.close()
        XCTAssertFalse(window.isOpen())
    }
}
