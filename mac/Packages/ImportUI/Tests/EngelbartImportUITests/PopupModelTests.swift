import XCTest
import EngelbartCore
import EngelbartConnect
@testable import EngelbartImportUI

// NeedPopup.jsx needCopy, ImportStatus.jsx (jobState, nothingLines, rows, completion), ProviderPopup.jsx providerCopy
// (test/connect-own-signins.test.cjs, provider-connect), and model/onboarding.js keychainStep / afterAllow / agentChoice
// (test/onboarding-beta-screens.test.cjs).

final class PopupModelTests: XCTestCase {
    func testNeedCopy() {
        let base: JSONValue = ["id": "n", "app": "Zotero", "kind": "signin", "browser": "Chrome", "opened": false, "busy": false, "error": ""]
        let copy = NeedPopupModel.needCopy
        XCTAssertEqual(copy(base), NeedCopy(title: "Sign in to Zotero", primary: "Sign in", secondary: "Skip"))
        XCTAssertEqual(copy(base.with("kind", "confirm")).primary, "Sign in", "any kind, for Zotero, is its own sign-in")
        XCTAssertEqual(copy(base.with("opened", true)).primary, "Open again")
        XCTAssertEqual(copy(base.with("opened", true)).text, "Finish signing in in your browser.")
        XCTAssertEqual(copy(base.with("app", "GitHub").with("opened", true).with("code", "WDJB-MJHT")).text, "Enter WDJB-MJHT on GitHub, then come back.")
        for words in [copy(base), copy(base.with("opened", true)), copy(base.with("app", "GitHub"))] {
            XCTAssertFalse("\(words.title) \(words.text) \(words.primary) \(words.secondary)".contains("Chrome"))
        }
        XCTAssertEqual(copy(base.with("app", "Obsidian").with("kind", "confirm").with("reason", "Open Obsidian once so its vault is indexed.")),
                       NeedCopy(title: "Open Obsidian once so its vault is indexed", primary: "Done", secondary: "Skip"))
        XCTAssertEqual(copy(base.with("app", "Granola").with("kind", "connector")), NeedCopy(title: "Connect Granola", primary: "Connect", secondary: "Skip", waiting: false))
        XCTAssertEqual(copy(base.with("app", "Granola").with("kind", "connector").with("busy", true)).primary, "Waiting…")
        for kind in ["signin", "code", "2fa", "captcha", "confirm", "folder", "connector"] {
            let words = copy(base.with("app", "Notion").with("kind", .string(kind)))
            XCTAssertFalse(words.text.contains("Continue in"), kind)
            XCTAssertEqual(words.secondary, "Skip", kind)
        }
        XCTAssertEqual(copy(base.with("app", "Notion")).primary, "Open Chrome")
        XCTAssertEqual(copy(base.with("app", "Notion").with("kind", "permission")), NeedCopy(title: "Allow Engelbart to read Notion?", primary: "Allow", secondary: "Don’t allow"))
        XCTAssertEqual(copy(base.with("app", "ChatGPT").with("kind", "signin-here").with("where", "here")).primary, "Sign in inside Engelbart")
        XCTAssertEqual(copy(base.with("app", "Gmail").with("kind", "signin-here").with("where", "browser")).primary, "Sign in in Chrome")
        XCTAssertEqual(copy(base.with("app", "Notion").with("opened", true)).primary, "I’m signed in")
        XCTAssertTrue(NeedPopupModel.finishing(base.with("app", "Notion").with("opened", true)))
        XCTAssertFalse(NeedPopupModel.finishing(base.with("opened", true)), "Zotero's own closes by itself")
        XCTAssertFalse(NeedPopupModel.finishing(base.with("app", "Granola").with("kind", "connector").with("opened", true)))
    }

    func testCompletionOneRowALogo() {
        func job(_ id: String, _ apps: [String], _ label: String) -> JSONValue {
            ["id": .string(id), "kind": "import", "apps": .array(apps.map(JSONValue.string)), "label": .string(label), "status": "done", "notes": 2, "items": 0]
        }
        let jobs = [job("1", ["Obsidian"], "Notes: Obsidian"), job("2", ["Claude"], "AI chats: Claude"), job("3", ["Claude Code"], "AI chats: Claude Code"), job("4", ["__sites"], "Websites: Saved URLs"), job("5", [], "Other tools: Linear")]
        let ended = ImportStatusModel.ended(["id": "s", "finished": true, "jobs": .array(jobs), "needs": [], "leftOut": []])!
        XCTAssertEqual(ended.title, "Your imports are complete!")
        XCTAssertEqual(ended.body, "All of the sources you have selected are now inside of your Engelbart Library.")
        XCTAssertEqual(ended.rows.map(\.name), ["Obsidian", "Claude, Claude Code", "Saved URLs, Linear"])
    }

    func testNothingLinesAndLeftOutRows() {
        let jobs: [JSONValue] = [
            ["id": "1", "kind": "import", "apps": ["Zotero"], "label": "Papers: Zotero", "status": "done", "notes": 0, "items": 0, "summary": "Zotero was skipped."],
            ["id": "2", "kind": "import", "apps": ["Granola"], "label": "Meeting transcripts: Granola", "status": "failed", "notes": 0, "items": 0, "error": "The model is at capacity. Try later."],
            ["id": "3", "kind": "import", "apps": ["Obsidian"], "label": "Notes: Obsidian", "status": "done", "notes": 4, "items": 0],
            ["id": "4", "kind": "import", "apps": ["Overleaf"], "label": "Papers: Overleaf", "status": "done", "notes": 0, "items": 0, "summary": "No project matched the study. Looked at 12."],
        ]
        let session: JSONValue = ["id": "s", "finished": true, "jobs": .array(jobs), "needs": [], "leftOut": [["app": "Zotero", "why": "you skipped signing in"], ["app": "GitHub", "why": "you skipped signing in"]]]
        XCTAssertEqual(ImportStatusModel.nothingLines(session, jobs: jobs, imported: [jobs[2]]).map(\.line), [
            "Nothing came in from Zotero: you skipped signing in.",
            "Nothing came in from Granola: its import failed (The model is at capacity).",
            "Nothing came in from Overleaf. No project matched the study.",
            "Nothing came in from GitHub: you skipped signing in.",
        ])
        let ended = ImportStatusModel.ended(session)!
        XCTAssertEqual(ended.title, "Your imports have finished")
        XCTAssertEqual(ended.rows.map(\.name), ["Obsidian"])
        let running = session.with("jobs", [jobs[2].with("status", "running")])
        XCTAssertNil(ImportStatusModel.ended(running))
        let rows = ImportStatusModel.rows(running)
        XCTAssertEqual(rows.last?.id, "left-GitHub")
        XCTAssertEqual(rows.last?.state, "Left out")
        XCTAssertEqual(rows.first?.state, "4 added")
    }

    func testJobStateAndRowsOrder() {
        XCTAssertEqual(ImportStatusModel.jobState(["status": "failed"]), "Couldn’t import")
        XCTAssertEqual(ImportStatusModel.jobState(["status": "running", "notes": 0, "items": 0]), "Working")
        XCTAssertEqual(ImportStatusModel.jobState(["status": "done", "notes": 2, "items": 1]), "Done · 3")
        XCTAssertEqual(ImportStatusModel.jobState(["status": "done"]), "Done")
        XCTAssertEqual(ImportStatusModel.jobState(["status": "queued"]), "Queued")
        XCTAssertEqual(ImportStatusModel.jobState(["status": "stopped"]), "Stopped")
        XCTAssertEqual(ImportStatusModel.jobState(["skipped": true, "status": "running"]), "Left out")
        let session: JSONValue = ["id": "s", "jobs": [
            ["id": "a", "kind": "import", "apps": ["Obsidian"], "status": "done", "notes": 1],
            ["id": "b", "kind": "recall", "apps": ["Claude"], "status": "running"],
            ["id": "c", "kind": "import", "apps": ["Notion"], "status": "queued"],
            ["id": "d", "kind": "survey", "apps": ["Overleaf"], "status": "waiting"],
            ["id": "e", "kind": "import", "apps": ["Zotero"], "status": "running"],
        ], "needs": [["id": "n1", "app": "Overleaf", "kind": "signin"], ["id": "n2", "app": "Granola", "kind": "connector"]]]
        let rows = ImportStatusModel.rows(session)
        XCTAssertEqual(rows.map(\.id), ["need-n2", "d", "e", "c", "a"], "held first, recalls left out, waiting/running/queued/ended")
        XCTAssertEqual(rows[0].needId, "n2")
        XCTAssertEqual(rows[1].needId, "n1")
        XCTAssertEqual(rows.map(\.name), ["Granola", "Overleaf", "Zotero", "Notion", "Obsidian"])
        XCTAssertFalse(ImportStatusModel.isEnded(session.with("needs", []).with("jobs", [["id": "a", "kind": "import", "status": "done"]]).with("holding", true)), "nothing ends while a sign-in is held")
        XCTAssertEqual(ImportStatusModel.needWords(["app": "Notion", "kind": "signin", "own": true, "browser": "Chrome"]).button, "Open Chrome")
        XCTAssertEqual(ImportStatusModel.needWords(["app": "Apple Notes", "kind": "permission"]).title, "Apple Notes needs permission")
    }

    func testProviderCopy() {
        let ready: JSONValue = ["installed": true, "signedIn": true, "status": "ready"]
        XCTAssertTrue(ProviderPopupModel.cliReady(ready))
        XCTAssertTrue(ProviderPopupModel.cliReady(ready.with("status", "updating")))
        XCTAssertFalse(ProviderPopupModel.cliReady(ready.with("status", "outdated")))
        XCTAssertTrue(ProviderPopupModel.cliReady(ready.with("status", "outdated").with("autoUpdate", true)))
        XCTAssertFalse(ProviderPopupModel.cliReady(ready.with("signedIn", nil)), "signed in only when the CLI says so")
        let copy = ProviderPopupModel.providerCopy
        XCTAssertEqual(copy("anthropic", ready, "", true).state, "ready")
        XCTAssertEqual(copy("anthropic", ready, "", true).line, "Connected. Your imports are starting again.")
        XCTAssertEqual(copy("anthropic", ready, "", false), ProviderCopy(state: "refused", line: "Claude Code couldn’t run your imports.", primary: "Sign in again", waiting: false, problem: true))
        XCTAssertEqual(copy("openai", ready, "No subscription.", false).line, "No subscription.")
        let signing = ready.with("signedIn", false).with("status", "signed-out").with("busy", ["action": "sign-in", "url": "https://x"])
        XCTAssertEqual(copy("anthropic", signing, "", true).primary, "Open page")
        XCTAssertEqual(copy("anthropic", signing.with("busy", ["action": "sign-in"]), "", true).primary, "Waiting…")
        XCTAssertEqual(copy("openai", ["status": "installing"], "", true), ProviderCopy(state: "connecting", line: "Connecting Codex…", primary: "Connecting…", waiting: true, problem: false))
        XCTAssertEqual(copy("anthropic", ["status": "missing", "installed": false], "", false), ProviderCopy(state: "not-connected", line: "", primary: "Connect", waiting: false, problem: false))
        XCTAssertEqual(copy("anthropic", ["status": "failed", "error": "No internet. More words."], "", false).line, "No internet.")
    }

    func testKeychainStepAndAfterAllow() {
        let H = OnboardingHelpers.self
        let chrome: JSONValue = ["id": "chrome", "name": "Google Chrome", "keychain": true, "profiles": []]
        XCTAssertEqual(H.keychainStep(nil), .wait)
        XCTAssertEqual(H.keychainStep(["browsers": [], "keychain": nil]), .go("declined"))
        XCTAssertEqual(H.keychainStep(["browsers": [chrome], "chosenId": "chrome", "keychain": nil]), .ask)
        XCTAssertEqual(H.keychainStep(["browsers": [chrome], "chosenId": "chrome", "keychain": "allowed"]), .go("allowed"))
        XCTAssertEqual(H.keychainStep(["browsers": [chrome], "chosenId": "chrome", "keychain": "refused"]), .go("declined"))
        let safari: JSONValue = ["id": "safari", "name": "Safari", "keychain": false, "profiles": []]
        XCTAssertEqual(H.keychainStep(["browsers": [safari, chrome], "chosenId": "safari", "keychain": nil, "safari": ["diskAccess": false]]), .safari)
        XCTAssertEqual(H.keychainStep(["browsers": [safari], "chosenId": "safari", "keychain": nil]), .safari)
        XCTAssertEqual(H.keychainStep(["browsers": [safari], "chosenId": "safari", "keychain": nil, "safari": ["diskAccess": true]]), .ask)
        let two = chrome.with("profiles", [["id": "Default", "name": "Hudson", "email": "h@x"], ["id": "Profile 1", "name": "Work"]])
        XCTAssertEqual(H.afterAllow(["browsers": [two], "chosenId": "chrome"]), "profile")
        XCTAssertEqual(H.afterAllow(["browsers": [two], "chosenId": "chrome", "chosenProfile": "Profile 1"]), "macos")
        XCTAssertEqual(H.afterAllow(["browsers": [two], "chosenId": "chrome", "chosenProfile": "Gone"]), "profile")
        XCTAssertEqual(H.afterAllow(["browsers": [chrome], "chosenId": "chrome"]), "macos")
        XCTAssertFalse(H.runKeychain(nil))
        XCTAssertFalse(H.runKeychain(["keychain": "declined"]))
        XCTAssertTrue(H.runKeychain(["keychain": "allowed"]))
    }

    /// A tool check's snapshot: `states` gives each tool's fields (status 'ready' unless said).
    func snap(_ states: [String: [String: JSONValue]] = [:]) -> JSONValue {
        var tools: [String: JSONValue] = [:]
        for id in ["git", "claude", "codex"] {
            let given = states[id] ?? [:]
            let status = given["status"]?.string ?? "ready"
            var tool: [String: JSONValue] = ["id": .string(id), "installed": .bool(status != "missing"), "status": .string(status), "signedIn": status == "ready" ? true : nil, "busy": nil, "autoUpdate": false, "error": nil]
            for (k, v) in given { tool[k] = v }
            tools[id] = .object(tool)
        }
        return ["checked": true, "platform": "darwin", "tools": .object(tools)]
    }
    func prov(_ who: [String: JSONValue] = [:]) -> JSONValue {
        ["providers": .array(["anthropic", "openai"].map { id in
            var o: [String: JSONValue] = ["id": .string(id), "installed": true, "signedIn": false, "subscription": nil]
            for (k, v) in who[id]?.object ?? [:] { o[k] = v }
            return .object(o)
        }), "decision": nil]
    }

    func testAgentChoice() {
        let H = OnboardingHelpers.self
        let SUB: JSONValue = ["signedIn": true, "subscription": "max", "subscribed": true]
        let FREE: JSONValue = ["signedIn": true, "subscription": nil, "subscribed": false]
        let missing = H.agentChoice(snap(["claude": ["status": "missing"], "codex": ["status": "missing"]]), prov(), "both")
        XCTAssertEqual(missing.install, ["claude", "codex"])
        XCTAssertEqual(missing.primary.label, "Connecting…")
        XCTAssertTrue(missing.primary.disabled)
        XCTAssertEqual(H.agentChoice(snap(["codex": ["status": "outdated"]]), prov(), "codex").update, ["codex"])
        let signedOut = snap(["claude": ["status": "signed-out", "signedIn": false], "codex": ["status": "signed-out", "signedIn": false]])
        XCTAssertEqual(H.agentChoice(signedOut, prov(), "claude").primary.label, "Connect to Claude")
        XCTAssertEqual(H.agentChoice(signedOut, prov(), "codex").primary.label, "Connect to ChatGPT")
        let bothOut = H.agentChoice(signedOut, prov(), "both")
        XCTAssertEqual([bothOut.primary.label, bothOut.primary.action ?? ""], ["Connect to Claude and ChatGPT", "sign-in"])
        XCTAssertEqual(bothOut.primary.ids, ["claude", "codex"])
        XCTAssertEqual(H.agentChoice(snap(), prov(["anthropic": FREE]), "claude").primary.label, "Connect to Claude")
        XCTAssertEqual(H.agentChoice(snap(), prov(["anthropic": SUB]), "claude", refused: "claude").primary.action, "sign-in")
        XCTAssertTrue(H.agentChoice(snap(["codex": ["status": "missing", "busy": ["action": "install"]]]), prov(["anthropic": SUB]), "both").done)
        let signing = H.agentChoice(snap(["claude": ["status": "signed-out", "busy": ["action": "sign-in", "url": "https://claude.ai/x"]]]), prov(), "claude")
        XCTAssertEqual(signing.primary.action, "open")
        XCTAssertEqual(signing.primary.url, "https://claude.ai/x")
        let failed = H.agentChoice(snap(["codex": ["status": "missing", "error": "The installer could not be reached: no internet connection. More."]]), prov(), "codex")
        XCTAssertEqual(failed.primary.label, "Try again")
        XCTAssertEqual(failed.problem, "The installer could not be reached: no internet connection.")
        XCTAssertTrue(H.agentChoice(snap(), prov(), nil).primary.disabled)
        for choice in ["claude", "codex", "both"] {
            for state in [snap(["claude": ["status": "outdated", "version": "2.1.1"], "codex": ["status": "missing"]]), snap(["claude": ["status": "signed-out"]])] {
                let out = H.agentChoice(state, prov(), choice)
                XCTAssertNil("\(out.primary.label) \(out.problem)".range(of: #"\d+\.\d+\.\d+"#, options: .regularExpression))
            }
        }
        XCTAssertEqual(H.connectLabel(["codex", "claude"]), "Connect to Claude and ChatGPT")
        XCTAssertEqual(H.providerOfChoice("claude"), "anthropic")
        XCTAssertNil(H.providerOfChoice("both"))
    }

    func testRowOf() {
        let H = OnboardingHelpers.self
        XCTAssertEqual(H.rowOf(["id": "claude", "name": "Claude Code", "busy": ["action": "install"]]).state, "Connecting…")
        XCTAssertEqual(H.rowOf(["id": "git", "name": "Git", "busy": ["action": "install"]]).state, "Installing…")
        let signIn = H.rowOf(["id": "codex", "name": "Codex", "busy": ["action": "sign-in", "url": "u"]])
        XCTAssertEqual([signIn.state, signIn.action ?? "", signIn.page ?? ""], ["Finish signing in in your browser", "cancel", "u"])
        XCTAssertEqual(H.rowOf(["id": "claude", "status": "signed-out"]).action, "sign-in")
        XCTAssertEqual(H.rowOf(["id": "claude", "status": "missing"]).state, "Not installed")
        XCTAssertEqual(H.rowOf(["id": "claude", "status": "outdated", "version": "1.0", "minimum": "2.0"]).state, "1.0 · needs 2.0")
        XCTAssertEqual(H.rowOf(["id": "claude", "status": "failed"]).action, "retry")
        XCTAssertEqual(H.rowOf(["id": "claude", "status": "ready", "version": "2.1"]).state, "2.1")
        XCTAssertEqual(H.rowOf(["id": "claude"]).state, "Connecting…")
    }
}
