import XCTest
import WebKit
import EngelbartCore
@testable import EngelbartConnect

/// fake.cjs's survey, find and CLI-gated agents; scan-child.cjs's jobs as background tasks; a recall's one message in the
/// agent window (sendOnly); recapture and "Use another account" in web-signin.cjs.
final class FakesAndScannerTests: XCTestCase {
    let anthropic = ConnectModels.choice("anthropic", models: nil)
    let openai = ConnectModels.choice("openai", models: nil)

    func testFakeSurveyAndFind() async throws {
        let fake = FakeAgents(delayMs: 0, env: [:])
        let survey = try await fake.turn(AgentTurnInput(choice: anthropic, kind: "survey", system: "", message: "", meta: AgentMeta(kind: "survey", info: ["job": ["apps": ["Google Docs"]]])))
        let read = SessionText.readSurvey(survey.text)
        XCTAssertEqual(read["items"]?.array?.map { JS.string($0["id"]) }, ["google-docs-1", "google-docs-2", "google-docs-3"])
        XCTAssertEqual(read["items"]?[0]?["label"]?.string, "Google Drive item 1")
        let home = TempDir()
        home.mkdir("Notes/Vault/.obsidian"); home.write("Movies/Zoom/2026-03-04 Lab/meeting.vtt", "WEBVTT"); home.write("Work/Papers/a.pdf", "%PDF"); home.mkdir("Library/Hidden/.obsidian")
        func find(_ app: String) async throws -> JSONValue {
            let out = try await fake.turn(AgentTurnInput(choice: anthropic, kind: "survey", system: "", message: "", meta: AgentMeta(kind: "survey", info: ["job": ["apps": [.string(app)], "find": true], "homeDir": .string(home.path)])))
            return try JSONValue.parse(Data(out.text.utf8))
        }
        let hoisted1 = try await find("Obsidian")["folder"]?.string
        XCTAssertEqual(hoisted1, home.url.appendingPathComponent("Notes/Vault").path)
        let hoisted2 = try await find("Zoom")["folder"]?.string
        XCTAssertEqual(hoisted2, home.url.appendingPathComponent("Movies/Zoom").path)
        let hoisted3 = try await find(ConnectSources.localPDFs)["folders"]
        XCTAssertEqual(hoisted3, [.string(home.url.appendingPathComponent("Work/Papers").path)])
        let none = try await find("Zoom")
        XCTAssertEqual(none["summary"]?.string, "Found the Zoom folder.")
        let empty = FakeAgents.findRun(homeDir: TempDir().path, app: "Zoom")
        XCTAssertEqual(empty["notes"]?.string, "No recordings on this Mac; cloud recordings at zoom.us/recording.")
    }

    func testCliGatedAgents() async throws {
        let base = FakeAgents(delayMs: 0, env: [:])
        func run(_ state: (present: Bool, broken: Bool, signedIn: Bool?), _ choice: AgentChoice, refuse: [String] = []) async -> String {
            do { _ = try await CliGatedAgents(base, state: { _ in state }, delayMs: 0, refuse: refuse).turn(AgentTurnInput(choice: choice, kind: "memory", system: "", message: "", meta: AgentMeta(kind: "memory"))); return "ran" }
            catch { return (error as? ConnectError)?.message ?? "\(error)" }
        }
        let hoisted4 = await run((false, false, nil), anthropic)
        XCTAssertEqual(hoisted4, "Claude Code was not found on the login shell PATH.")
        let hoisted5 = await run((true, true, true), openai)
        XCTAssertEqual(hoisted5, "Codex was not found on the login shell PATH.")
        let hoisted6 = await run((true, false, false), anthropic)
        XCTAssertEqual(hoisted6, "Not logged in · Please run /login")
        let hoisted7 = await run((true, false, nil), openai)
        XCTAssertEqual(hoisted7, "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.")
        let hoisted8 = await run((true, false, true), anthropic, refuse: ["claude"])
        XCTAssertEqual(hoisted8, "Credit balance is too low")
        let hoisted9 = await run((true, false, true), anthropic)
        XCTAssertEqual(hoisted9, "ran")
        XCTAssertTrue(ProviderFailure.needsProvider(ConnectError("failed", "Credit balance is too low")))
    }

    func testScannerRunsOffTheCallerAndGivesUpOnASlowJob() async throws {
        let scanner = Scanner(timeoutMs: 300)
        let onMain = try await scanner.run("detect") { Thread.isMainThread }
        XCTAssertFalse(onMain, "off the caller's thread")
        struct Boom: Error {}
        do { _ = try await scanner.run("localRepos") { () throws -> Int in throw Boom() }; XCTFail() } catch { XCTAssertTrue(error is Boom) }
        do { _ = try await scanner.run("projectDigest") { () -> Int in Thread.sleep(forTimeInterval: 2); return 1 }; XCTFail() }
        catch { XCTAssertEqual((error as? ConnectError)?.message, "The scan (projectDigest) took too long") }
        // The guard built for a job from the data root's answers: a folder macOS allowed reads, one it refused does not.
        let home = TempDir(), root = TempDir()
        home.mkdir("Desktop/notes"); home.mkdir("Documents/x")
        FolderAccess.writeAnswers(dataRoot: root.url, ["Desktop": "allowed", "Documents": "denied"])
        let guardian = FolderAccess.guardFor(homeDir: home.path, dataRoot: root.url)
        let readable = try await scanner.run("guard") { (guardian.readable(home.url.appendingPathComponent("Desktop/notes").path), guardian.readable(home.url.appendingPathComponent("Documents/x").path)) }
        XCTAssertTrue(readable.0); XCTAssertFalse(readable.1)
    }

    // browser.cjs sendOnly: a recall types exactly Engelbart's question once into the message box and sends it; nothing else.
    @MainActor
    func testRecallSendsOnlyItsQuestion() async throws {
        let server = try TestServer()
        server.route("/chat.html", .init("""
        <html><head><title>Chat</title></head><body>
        <textarea aria-label="Message" id="box"></textarea>
        <button aria-label="Send prompt" onclick="document.title='sent: ' + document.getElementById('box').value">Send</button>
        </body></html>
        """))
        let store = WKWebsiteDataStore.nonPersistent()
        let windows = AgentBrowserWindows(store: { store }, headless: true)
        defer { windows.closeAll() }
        let question = "What do you remember about my research?"
        let p = windows.tools(AgentJob(id: "recall-1", label: "ChatGPT", sites: ["127.0.0.1"], sendOnly: question))
        _ = try await p.open("\(server.base)/chat.html")
        let read = try await p.read(offset: 0, maxChars: 2000)
        let box = JS.string((read["elements"]?.array ?? []).first { $0["name"]?.string == "Message" }?["ref"])
        let send = JS.string((read["elements"]?.array ?? []).first { $0["name"]?.string == "Send prompt" }?["ref"])
        do { _ = try await p.type(box, "Something else", submit: false, replace: true); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.kind, "read-only") }
        do { _ = try await p.click(send); XCTFail("nothing typed yet") } catch { XCTAssertEqual((error as? ConnectError)?.kind, "read-only") }
        _ = try await p.type(box, question, submit: false, replace: true)
        _ = try await p.click(send)
        let sent = await eventually(5) { (try? await p.evaluate("return document.title"))?.string == "sent: \(question)" }
        XCTAssertTrue(sent)
        do { _ = try await p.click(send); XCTFail("sent once") } catch { XCTAssertEqual((error as? ConnectError)?.kind, "read-only") }
    }

    // recapture (the native-browser fallback) and "Use another account".
    func testRecaptureAndAnotherAccount() async {
        let jar = FakeJar()
        let importer = FakeImporter([.init(id: "chrome", profiles: [.init(id: "Default", name: "Me", signedIn: true)])], cookie: ("chatgpt.com", "__Secure-next-auth.session-token"), jar: jar)
        let opened = Box<[String]>([])
        let web = WebSignIn(importer: importer, jar: jar, defaultBrowser: { "Google Chrome" }, openExternal: { opened.set(opened.get() + [$0]); importer.opened = true },
                            pollMs: 1, slowPollMs: 1, timeoutMs: 200, sleep: { _ in await Task.yield() })
        let at = await web.recapture(app: "ChatGPT")
        XCTAssertTrue(at.signedIn); XCTAssertEqual(at.browser, "Chrome"); XCTAssertEqual(opened.get(), [], "copied at once: nothing opened")
        let gone = FakeImporter([.init(id: "chrome", profiles: [.init(id: "Default", name: "Me", signedIn: false)])], cookie: ("chatgpt.com", "__Secure-next-auth.session-token"), jar: FakeJar())
        gone.signedInAfterOpen = true
        let opened2 = Box<[String]>([])
        let web2 = WebSignIn(importer: gone, jar: gone.jar, defaultBrowser: { "Google Chrome" }, openExternal: { opened2.set(opened2.get() + [$0]); gone.opened = true },
                             pollMs: 1, slowPollMs: 1, timeoutMs: 500, sleep: { _ in await Task.yield() })
        let later = await web2.recapture(app: "ChatGPT")
        XCTAssertTrue(later.signedIn, "\(later)"); XCTAssertEqual(opened2.get(), ["https://chatgpt.com/auth/login"])
        // Another account: only Google, only while its page is being waited on in a browser.
        let none = await web.anotherAccount("ChatGPT")
        XCTAssertFalse(none.opened)
        let google = FakeImporter([.init(id: "chrome", profiles: [.init(id: "Default", name: "Me", signedIn: false)])], cookie: ("google.com", "SID"), jar: FakeJar())
        let opened3 = Box<[String]>([])
        let web3 = WebSignIn(importer: google, jar: google.jar, defaultBrowser: { "Google Chrome" }, openExternal: { opened3.set(opened3.get() + [$0]) }, pollMs: 1, slowPollMs: 1, timeoutMs: 400, sleep: { _ in await Task.yield() })
        let waiting = Task { await web3.signIn("Gmail") }
        _ = await eventually(5) { opened3.get().count == 1 }
        let another = await web3.anotherAccount("Gmail")
        XCTAssertTrue(another.opened); XCTAssertEqual(another.browser, "Chrome")
        XCTAssertEqual(opened3.get().last, WebSignIn.anotherAccountPage)
        _ = await waiting.value
    }
}
