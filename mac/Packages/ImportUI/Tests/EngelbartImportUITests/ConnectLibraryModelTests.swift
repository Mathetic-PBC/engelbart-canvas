import XCTest
import EngelbartCore
import EngelbartConnect
@testable import EngelbartImportUI

// Connect your library's screen through its model (ConnectLibrary.jsx), main faked: ticking and its consents, the
// sign-in checks, the Keychain modal, the gate before the run, folder access, the chat and the working view; the dock's
// chip and the workspace's popups (ConnectDock.jsx, App.jsx).

@MainActor
final class ConnectLibraryModelTests: XCTestCase {
    func screen(_ api: FakeImportAPI, mode: ConnectLibraryContext.Mode = .popup, sessionId: String? = nil, projectId: String? = "p1") async -> ConnectLibraryModel {
        var context = ConnectLibraryContext(mode: mode, sessionId: sessionId, projectId: projectId, workspaceId: projectId == nil ? nil : "w1")
        context.onSession = { _ in }
        let m = ConnectLibraryModel(api: api, context: context, openSessions: OpenSessions())
        await m.start()
        return m
    }

    func testChooseStartsFromWhatMainFound() async {
        let api = FakeImportAPI()
        let m = await screen(api)
        XCTAssertEqual(m.view, "choose")
        XCTAssertTrue(ConnectModel.ticked(m.picks, "notes", "Obsidian"))
        XCTAssertFalse(ConnectModel.ticked(m.picks, "chats", "ChatGPT"))
        XCTAssertEqual(m.provider, "anthropic")
        XCTAssertEqual(m.targetName, "Claude Code")
        XCTAssertEqual(m.label("Cursor", "chats").text, "")
        XCTAssertEqual(m.label("Cursor", "chats").tone, "")
        XCTAssertTrue(m.ready)
    }

    func testTickingIsTheConsent() async {
        let api = FakeImportAPI()
        let m = await screen(api)
        // A connector: its sign-in starts.
        await m.toggleApp("notes", "Notion")
        XCTAssertTrue(api.calls.contains("connectConnectorSignIn Notion"))
        XCTAssertTrue(ConnectModel.ticked(m.picks, "notes", "Notion"))
        XCTAssertEqual(m.label("Notion", "notes").text, "signed in")
        api.answer["connectorSignIn"] = { app in ["app": .string(app), "connected": false] }
        await m.toggleApp("transcripts", "Granola")
        XCTAssertFalse(ConnectModel.ticked(m.picks, "transcripts", "Granola"), "a sign-in that did not finish unticks")
        // Apple Notes asks macOS.
        api.answer["notesPermission"] = { _ in ["allowed": false, "error": "Engelbart is not allowed"] }
        await m.toggleApp("notes", "Apple Notes")
        XCTAssertFalse(ConnectModel.ticked(m.picks, "notes", "Apple Notes"))
        XCTAssertEqual(m.error, "Apple Notes: Engelbart is not allowed")
        XCTAssertEqual(m.label("Apple Notes", "notes"), RowLabel(text: "Engelbart is not allowed", tone: "error"))
        // A local app that was not found asks for its folder.
        api.pickedDirectory = "/Users/you/Zoom"
        await m.toggleApp("transcripts", "Zoom")
        XCTAssertTrue(ConnectModel.ticked(m.picks, "transcripts", "Zoom"))
        XCTAssertEqual(m.label("Zoom", "transcripts").text, "~/Zoom")
        // Zotero: Engelbart's own sign-in.
        await m.toggleApp("papers", "Zotero")
        XCTAssertTrue(api.calls.contains("engelbartSignIn Zotero"))
        XCTAssertEqual(m.label("Zotero", "papers").text, "signed in")
        // Unticking.
        await m.toggleApp("notes", "Notion")
        XCTAssertFalse(ConnectModel.ticked(m.picks, "notes", "Notion"))
    }

    func testAWebAppTickedIsCheckedAndOpensItsSignInWhenSignedOut() async {
        let api = FakeImportAPI()
        api.answer["signInCheck"] = { _ in ["status": "signed-out", "browser": ""] }
        api.answer["signInWindow"] = { _ in ["status": "signed-in"] }
        let m = await screen(api)
        await m.toggleApp("chats", "Perplexity")
        await until("its window") { api.calls.contains("connectSignInWindow Perplexity") }
        await until("signed in") { m.signIns["Perplexity"]?.status == "signed-in" }
        XCTAssertEqual(m.label("Perplexity", "chats").text, "✓ Signed in")
        // A window closed without signing in: unticked.
        api.answer["signInWindow"] = { _ in ["status": "closed"] }
        await m.toggleApp("chats", "Grok")
        await until("unticked") { !ConnectModel.ticked(m.picks, "chats", "Grok") && api.calls.contains("connectSignInWindow Grok") }
        XCTAssertEqual(m.signIns["Grok"], SignIn(status: "signed-out"), "back to what it was before the window")
        XCTAssertEqual(m.label("Grok", "chats"), RowLabel(text: "Needs sign-in", tone: "muted"), "unticked, it says nothing of its sign-in")
    }

    func testTheKeychainModalBeforeMacOSAsks() async {
        let api = FakeImportAPI()
        api.answer["signInNote"] = { _ in ["note": "macOS will ask", "browser": "Chrome"] }
        let m = await screen(api)
        await m.toggleApp("chats", "ChatGPT")
        await until("the modal") { m.asking != nil }
        XCTAssertEqual(m.asking?.title, "Use your Chrome sign-ins for ChatGPT?")
        XCTAssertFalse(api.calls.contains { $0.hasPrefix("connectSignInCheck") }, "nothing checked before Continue")
        await m.allowSignIns("Chrome")
        await until("checked") { m.signIns["ChatGPT"]?.status == "signed-in" }
        XCTAssertEqual(m.keychainOutcome?.title, "Signed in to ChatGPT")
        XCTAssertEqual(m.keychainOutcome?.tone, "ok")
        // Not now: declined, and Sign in (Engelbart's window) opens by itself in the chain.
        api.answer["signInWindow"] = { _ in ["status": "signed-in"] }
        m.keychainRun = nil
        await m.toggleApp("chats", "Claude")
        await until("asked") { m.asking != nil }
        m.declineSignIns("Chrome")
        XCTAssertNil(m.asking)
        await until("its window") { api.calls.contains("connectSignInWindow Claude") }
        // The consent off: the panels go and nothing is checked.
        await m.toggleApp("chats", "Grok")
        await until("asked") { m.asking != nil }
        m.toggleConsent()
        XCTAssertNil(m.asking)
        XCTAssertFalse(m.consent)
    }

    func testTheGateAndTheRun() async {
        let api = FakeImportAPI()
        api.answer["signInCheck"] = { _ in ["status": "", "browser": ""] }
        var started: String?
        var context = ConnectLibraryContext(mode: .popup, projectId: "p1", workspaceId: "w1")
        context.onSession = { started = $0 }
        let m = ConnectLibraryModel(api: api, context: context, openSessions: OpenSessions())
        await m.start()
        m.toggleAll(false)
        await m.bringIn()
        XCTAssertEqual(m.error, "Pick at least one source.")
        m.setRow("chats", "ChatGPT", true)
        m.setRow("notes", "Obsidian", true)
        await m.bringIn()
        XCTAssertEqual(m.gate, "ask")
        XCTAssertEqual(m.gateView?.title, "ChatGPT needs you to sign in")
        XCTAssertTrue(m.gateCanSignIn)
        m.gateLeave()
        await until("the run") { m.view == "chat" }
        XCTAssertFalse(ConnectModel.ticked(m.picks, "chats", "ChatGPT"), "left out")
        XCTAssertEqual(started, "sample-session")
        let choices = api.lastChoices!
        XCTAssertEqual(choices["projectId"], "p1")
        XCTAssertEqual(choices["workspaceId"], "w1")
        XCTAssertEqual(choices["provider"], "anthropic")
        XCTAssertEqual(choices["sources"]?["notes"]?["apps"], ["Obsidian"])
        XCTAssertEqual(choices["days"], 365)
        XCTAssertTrue(api.calls.contains("connectSignInWindowClose"))
    }

    func testFolderAccessAskedBeforeTheRun() async {
        let api = FakeImportAPI()
        api.answer["foldersNeeded"] = { _ in [["id": "Desktop", "name": "Desktop"], ["id": "Downloads", "name": "Downloads"]] }
        api.found = api.found.with("apps", ["Obsidian": ["found": true]])
        let m = await screen(api)
        XCTAssertNil(m.folderShown, "rows ticked from the start wait for Bring these in")
        m.setRow("papers", ConnectModel.localPDFs, true)
        await until("the folder modal") { m.folderShown != nil }
        XCTAssertEqual(m.folderShown?.title, "Let Engelbart read your folders?")
        await m.allowFolders()
        XCTAssertEqual(m.label(ConnectModel.localPDFs, "papers"), RowLabel(text: "✓ Desktop · Downloads not allowed", tone: "ok"))
        await m.bringIn()
        await until("asked again before the run") { m.folderShown != nil }
        await m.declineFolders()
        await until("the run") { m.view == "chat" }
    }

    func testTheChatAndTheWorkingView() async {
        let api = FakeImportAPI()
        var session = FakeImportAPI.sampleSession(nil)
        session = session.with("chat", [["role": "agent", "opener": true, "text": "Looking…"],
                                        ["role": "agent", "grant": ["rows": [["id": "Notion", "name": "Notion"], ["id": "ChatGPT", "name": "ChatGPT"]], "answered": nil]],
                                        ["role": "agent", "text": "Which folders?", "ask": ["kind": "multi", "title": "Which folders?", "options": [["label": "Research", "why": "48 notes"]]]]])
        session = session.with("finished", false)
        api.sessions["sample-session"] = session
        var closed = false
        var context = ConnectLibraryContext(mode: .popup, sessionId: "sample-session")
        context.onClose = { closed = true }
        let open = OpenSessions()
        let m = ConnectLibraryModel(api: api, context: context, openSessions: open)
        await m.start()
        XCTAssertEqual(m.view, "chat")
        XCTAssertTrue(open.isOpen("sample-session"), "the dock leaves it alone while it is shown")
        XCTAssertTrue(m.spoke)
        XCTAssertEqual(m.last, 2)
        XCTAssertTrue(m.live(2))
        await m.grantApps(["Notion"])
        XCTAssertEqual(GrantLogic.answered(m.chat[1]["grant"]!), "Allowed Notion")
        await m.reply(["picked": ["Research"]])
        XCTAssertEqual(J.str(m.chat.last?["text"]), "Research")
        XCTAssertFalse(m.live(2), "answered")
        api.announce(m.session!.with("thinking", false).with("needs", [["id": "n1", "app": "Notion", "kind": "connector"]]))
        await until("the announcement") { m.needs.count == 1 && J.str(m.needs[0]["id"]) == "n1" }
        await m.needSkip(m.needs[0])
        XCTAssertTrue(m.needs.isEmpty)
        await m.importNow()
        XCTAssertEqual(m.view, "working")
        XCTAssertTrue(m.going)
        await m.stopJob(m.jobs[0])
        XCTAssertEqual(J.str(m.jobs[0]["status"]), "stopped")
        m.putAway()
        XCTAssertTrue(closed)
        await until("minimized") { api.calls.contains("connectMinimize sample-session true") }
        m.stop()
        XCTAssertFalse(open.isOpen("sample-session"))
    }

    func testBackFromImportYourContextsManualRunStopsAndDismisses() async {
        let api = FakeImportAPI()
        api.sessions["s"] = ["id": "s", "chat": [], "jobs": [], "needs": []]
        var back = false
        var context = ConnectLibraryContext(mode: .onboarding, sessionId: "s")
        context.onBack = { back = true }
        let m = ConnectLibraryModel(api: api, context: context, openSessions: OpenSessions())
        await m.start()
        await m.back()
        XCTAssertTrue(back)
        XCTAssertTrue(api.calls.contains("connectStop s"))
        XCTAssertTrue(api.calls.contains("connectDismiss s"))
    }

    func testOnboardingPicksUpTheResumableSession() async {
        let api = FakeImportAPI()
        api.sessions["r"] = ["id": "r", "mode": "onboarding", "projectId": nil, "chat": [], "jobs": [], "needs": []]
        let m = await screen(api, mode: .onboarding, projectId: nil)
        XCTAssertEqual(m.view, "chat")
        XCTAssertEqual(J.str(m.session?["id"]), "r")
    }

    func testQuestionAndGrantRules() {
        XCTAssertEqual(QuestionCardLogic.pick([], "A", many: true), ["A"])
        XCTAssertEqual(QuestionCardLogic.pick(["A"], "B", many: true), ["A", "B"])
        XCTAssertEqual(QuestionCardLogic.pick(["A"], "A", many: true), [])
        XCTAssertEqual(QuestionCardLogic.pick(["A"], "B", many: false), ["B"])
        XCTAssertEqual(QuestionCardLogic.pick(["A"], "A", many: false), [])
        XCTAssertFalse(QuestionCardLogic.ready(kind: "multi", picks: [], note: " "), "Submit waits for a tick")
        XCTAssertTrue(QuestionCardLogic.ready(kind: "multi", picks: [], note: "mine"))
        XCTAssertFalse(QuestionCardLogic.ready(kind: "open", picks: ["A"], note: ""))
        XCTAssertEqual(QuestionCardLogic.submit(kind: "multi", picks: ["A"], note: " why "), ["picked": ["A"], "text": "why"])
        XCTAssertEqual(QuestionCardLogic.submit(kind: "single", picks: [], note: "x"), ["text": "x"])
        XCTAssertNil(QuestionCardLogic.submit(kind: "open", picks: [], note: ""))
        XCTAssertEqual(GrantLogic.allLabel(ids: ["a", "b"], picks: ["a"]), "Select all")
        XCTAssertEqual(GrantLogic.allLabel(ids: ["a", "b"], picks: ["b", "a"]), "Deselect all")
        XCTAssertEqual(GrantLogic.all(ids: ["a", "b"], picks: ["a"]), ["a", "b"])
        XCTAssertEqual(GrantLogic.all(ids: ["a", "b"], picks: ["a", "b"]), [])
        XCTAssertEqual(GrantLogic.answered(["answered": ["allowed": []]]), "Allowed none of them")
        XCTAssertNil(GrantLogic.answered(["answered": nil]))
    }

    func testTheChip() {
        let open = OpenSessions()
        XCTAssertNil(ConnectDockModel.chip([], isOpen: open.isOpen))
        let busy: JSONValue = ["id": "a", "needs": [], "done": true, "jobs": [["status": "running", "kind": "import"], ["status": "done", "kind": "import"]], "memory": ["status": "waiting"]]
        XCTAssertEqual(ConnectDockModel.chip([busy], isOpen: open.isOpen), ChipView(sessionId: "a", tone: "busy", short: "Importing 1/2", text: "Importing · 1 of 2 done", wave: true, red: false, color: "#8f8f8f"))
        let needs = busy.with("id", "b").with("needs", [["app": "Notion", "kind": "connector"]])
        let chip = ConnectDockModel.chip([busy, needs], isOpen: open.isOpen)!
        XCTAssertEqual(chip.sessionId, "b", "one needing the person first")
        XCTAssertEqual(chip.short, "Importing 1/2", "still the count, red")
        XCTAssertTrue(chip.red)
        XCTAssertEqual(chip.text, "Importing · 1 of 2 done · Notion needs you to sign in")
        XCTAssertEqual(chip.tooltip, "Importing · 1 of 2 done · Notion needs you to sign in: open it")
        open.mark("b", true)
        XCTAssertEqual(ConnectDockModel.chip([busy, needs], isOpen: open.isOpen)?.sessionId, "a", "not one this window shows")
        XCTAssertNil(ConnectDockModel.chip([busy.with("stopped", true)], isOpen: open.isOpen), "never a stopped session")
        let ended: JSONValue = ["id": "c", "direct": ["mode": "auto"], "jobs": [["kind": "import", "status": "done"]], "needs": []]
        XCTAssertTrue(ConnectDockModel.importsEnded(ended))
        XCTAssertNil(ConnectDockModel.chip([ended], isOpen: open.isOpen), "a run whose imports ended: its completion, no chip")
        let doneChip = ConnectDockModel.chip([["id": "d", "needs": [], "done": true, "jobs": [["status": "done", "notes": 2]], "memory": ["status": "saved"], "counts": ["notes": 2, "items": 0]]], isOpen: open.isOpen)!
        XCTAssertEqual(doneChip.label, "Library ✓")
        XCTAssertEqual(doneChip.color, "#171717")
        XCTAssertFalse(doneChip.wave)
    }

    func testSessionsFollowAnnouncements() async {
        let api = FakeImportAPI()
        api.sessions["x"] = ["id": "x"]
        let sessions = ConnectSessions(api: api)
        await sessions.start()
        XCTAssertEqual(sessions.list.map { J.str($0["id"]) }, ["x"])
        sessions.take(["id": "y"])
        XCTAssertEqual(sessions.list.map { J.str($0["id"]) }, ["y", "x"], "a new one goes first")
        sessions.take(["id": "x", "thinking": true])
        XCTAssertEqual(sessions.list[1]["thinking"], true)
        api.events.post("engelbart:connect", ["id": "y", "dismissed": true])
        await until("removed") { sessions.list.count == 1 }
    }

    func testTheWorkspacesPopupsOneAtATime() async {
        let api = FakeImportAPI()
        let sessions = ConnectSessions(api: api)
        let overlays = ImportOverlays(sessions: sessions, api: api)
        let need: JSONValue = ["id": "n1", "app": "Notion", "kind": "connector"]
        let run: JSONValue = ["id": "r", "direct": ["mode": "auto"], "jobs": [["id": "j", "kind": "import", "status": "running"]], "needs": [need]]
        api.sessions["r"] = run
        sessions.take(run)
        XCTAssertNil(overlays.pendingNeed, "off the workspace")
        overlays.inWorkspace = true
        XCTAssertEqual(overlays.pendingNeed?.need["id"], "n1")
        overlays.importModal = true
        XCTAssertNil(overlays.pendingNeed, "not while Import your context is open")
        overlays.importModal = false
        overlays.openSession("r")
        XCTAssertEqual(overlays.statusId, "r", "a direct run's chip opens its status")
        XCTAssertEqual(overlays.shown().need, true)
        XCTAssertEqual(overlays.shown().status, false, "the step first; the status waits behind it")
        overlays.later(run, need)
        XCTAssertNil(overlays.pendingNeed)
        await until("skipped") { api.calls.contains("connectNeed r n1 skip") }
        XCTAssertEqual(overlays.shown().status, true)
        overlays.needAgain(run, need)
        XCTAssertEqual(overlays.pendingNeed?.need["id"], "n1", "the status's Needs you brings it back")
        overlays.statusId = nil
        // The completion opens by itself, once.
        let ended = run.with("jobs", [["id": "j", "kind": "import", "status": "done", "notes": 2]]).with("needs", [])
        sessions.take(ended)
        await until("the completion") { overlays.statusId == "r" }
        overlays.statusId = nil
        sessions.take(ended.with("thinking", false))
        overlays.completions()
        XCTAssertNil(overlays.statusId, "once")
        // A manual run: its steps only once its chat is put away; its chip opens the chat.
        let manual: JSONValue = ["id": "m", "jobs": [], "needs": [["id": "n2", "app": "Zotero", "kind": "signin"]]]
        sessions.take(manual)
        overlays.connectPopup = "m"
        XCTAssertNotEqual(overlays.pendingNeed?.need["id"], "n2")
        overlays.connectPopup = nil
        overlays.openSession("m")
        XCTAssertEqual(overlays.connectPopup, "m")
        // A run blocked on its provider: Connect Claude Code, after the rest; Later until the next launch.
        overlays.connectPopup = nil
        let blocked: JSONValue = ["id": "b", "direct": ["mode": "auto"], "blocked": ["provider": "openai"], "jobs": [["kind": "import", "status": "queued"]], "needs": []]
        sessions.take(blocked)
        XCTAssertEqual(J.str(overlays.blockedSession?["id"]), "b")
        overlays.providerLater("b")
        XCTAssertNil(overlays.blockedSession)
        overlays.reset(defaults: UserDefaults(suiteName: "reset-\(UUID().uuidString)")!)
        XCTAssertTrue(overlays.laterNeeds.isEmpty && overlays.completedShown.isEmpty && overlays.laterProvider.isEmpty)
    }
}
