import XCTest
import EngelbartCore
import EngelbartConnect
@testable import EngelbartImportUI

// Ports of the model/connect.js tests: test/connect.test.cjs (the window's model, sign-in checks, Google and profiles,
// the gate, the period, workRow, footLine, off the Mac), connect-gmail, connect-folder-access, connect-shown-name,
// connect-turned-down, connect-auto-signin, connect-onboarding-beta.

typealias M = ConnectModel

func picksWith(_ rows: [(String, String)]) -> Picks {
    rows.reduce(M.initialPicks(["apps": [:]])) { M.tickRow($0, $1.0, $1.1, true) }
}
func sa(_ id: String, _ app: String) -> SourceApp { SourceApp(id: id, app: app) }
func label(_ text: String, _ tone: String, retry: Bool = false, signIn: Bool = false, here: Bool = false, another: Bool = false) -> RowLabel {
    RowLabel(text: text, tone: tone, retry: retry, signIn: signIn, here: here, another: another)
}

final class ConnectModelTests: XCTestCase {
    func testWorkspaceAndPlacedLine() {
        let sent = M.choicesOf(picks: [:], apps: [:], projectId: "p", workspaceId: "w")
        XCTAssertEqual(sent["workspaceId"], "w")
        XCTAssertNil(M.choicesOf(picks: [:], apps: [:], workspaceId: "w")["workspaceId"], "no project, no workspace")
        func line(_ project: Int, _ workspace: Int) -> String { M.placedLine(["projectId": "p", "placed": ["project": .number(Double(project)), "workspace": .number(Double(workspace))]]) }
        XCTAssertEqual(line(742, 500), "742 added to the project. The first 500 are also in this workspace.")
        XCTAssertEqual(line(3, 3), "3 added to the project. They are also in this workspace.")
        XCTAssertEqual(line(4, 0), "4 added to the project.")
        XCTAssertEqual(line(0, 0), "")
        XCTAssertEqual(M.placedLine(["projectId": nil, "placed": ["project": 3, "workspace": 0]]), "", "onboarding before its project")
    }

    func testProjectTrimmedAndResumable() {
        let long = "  " + String(repeating: "d", count: 5000) + "  "
        let sent = M.choicesOf(picks: [:], apps: [:], project: ("  Teachable agents  ", long))
        XCTAssertEqual(J.str(sent["project"]?["name"]), "Teachable agents")
        XCTAssertEqual(J.str(sent["project"]?["description"]).count, 4000)
        XCTAssertNil(sent["projectId"])
        XCTAssertNil(M.choicesOf(picks: [:], apps: [:], project: (" ", ""))["project"])
        XCTAssertNil(M.choicesOf(picks: [:], apps: [:])["project"])
        let entry: JSONValue = ["id": "s", "mode": "onboarding", "projectId": nil]
        XCTAssertEqual(M.resumable([entry]), entry)
        XCTAssertNil(M.resumable([entry.with("projectId", "p1")]), "it would not with an id")
        XCTAssertNil(M.resumable([entry.with("stopped", true)]))
        XCTAssertNil(M.resumable([entry.with("dismissed", true)]))
    }

    func testSignInWindowClosedLabels() {
        let found: JSONValue = ["apps": ["ChatGPT": ["found": true]]]
        func closed(_ was: SignIn?) -> RowLabel { M.rowLabel("ChatGPT", found: found, signIn: M.afterSignInWindowClosed(was)) }
        XCTAssertEqual(closed(SignIn(status: "refused", browser: "Chrome")), label("", "", signIn: true), "plain Sign in, no \"macOS didn't allow it\"")
        XCTAssertEqual(closed(SignIn(status: "rejected")), label("", "", signIn: true))
        XCTAssertEqual(closed(SignIn(status: "signed-out")), label("", "", signIn: true))
        XCTAssertEqual(closed(SignIn(status: "no-browser")), label("", "", signIn: true))
        XCTAssertNil(M.afterSignInWindowClosed(nil))
        XCTAssertEqual(M.afterSignInWindowClosed(SignIn(status: "declined", browser: "Chrome")), SignIn(status: "declined", browser: "Chrome"))
    }

    func testChooseScreenSignInChecks() {
        let found1: JSONValue = ["apps": ["ChatGPT": ["found": true]]]
        func l(_ signIn: SignIn?) -> RowLabel { M.rowLabel("ChatGPT", found: found1, signIn: signIn) }
        XCTAssertEqual(l(SignIn(status: "checking")), label("Checking…", "busy"))
        XCTAssertEqual(M.rowLabel("ChatGPT", found: found1, signIn: SignIn(status: "checking"), keychain: true), label("Waiting for macOS…", "busy"))
        XCTAssertEqual(l(SignIn(status: "signed-in", browser: "Chrome")), label("✓ Signed in from Chrome", "ok"))
        XCTAssertEqual(l(SignIn(status: "signed-in")), label("✓ Signed in", "ok"))
        XCTAssertEqual(l(SignIn(status: "signed-out")), label("", "", signIn: true))
        XCTAssertEqual(l(SignIn(status: "no-browser")), label("", "", signIn: true))
        XCTAssertEqual(l(SignIn(status: "refused", browser: "Chrome")), label("macOS didn't allow it", "error", retry: true, signIn: true))
        XCTAssertEqual(l(SignIn(status: "signing")), label("Signing in…", "busy"))
        XCTAssertEqual(l(SignIn(status: "declined")), label("", "", signIn: true))
        XCTAssertEqual(l(nil), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Granola", signIn: SignIn(status: "signed-in", browser: "Chrome")), label("Needs sign-in", "muted"), "only web apps")

        let found: JSONValue = ["apps": ["ChatGPT": ["found": true], "Claude": ["found": true], "Claude Code": ["found": true], "Obsidian": ["found": true]], "sites": ["found": false], "github": ["found": false]]
        let start = M.initialPicks(found)
        XCTAssertEqual(M.newlyTickedWeb(nil, start).filter { ["ChatGPT", "Claude"].contains($0.app) }, [], "assistants that remember start unticked")
        let one = M.tickRow(start, "chats", "ChatGPT", true)
        XCTAssertEqual(M.newlyTickedWeb(start, one), [sa("chats", "ChatGPT")])
        let cleared = M.tickGroup(start, "chats", found)
        let group = M.tickGroup(cleared, "chats", found)
        XCTAssertEqual(M.newlyTickedWeb(cleared, group), [sa("chats", "ChatGPT"), sa("chats", "Claude")], "the group's web apps, not Claude Code")
        let none = M.tickAll(start, found, false)
        let all = M.tickAll(none, found, true)
        XCTAssertEqual(M.newlyTickedWeb(none, all), [sa("chats", "ChatGPT"), sa("chats", "Claude")])
        XCTAssertEqual(M.newlyTickedWeb(all, M.tickAll(all, found, false)), [], "unticking checks nothing")

        var waiting = M.waitForYes([:], [YesInput(id: "chats", app: "ChatGPT", browser: "Chrome")])
        waiting = M.waitForYes(waiting, [YesInput(id: "chats", app: "Claude", browser: "Chrome"), YesInput(id: "chats", app: "ChatGPT", browser: "Chrome")])
        XCTAssertEqual(waiting, ["Chrome": [YesRow(id: "chats", app: "ChatGPT"), YesRow(id: "chats", app: "Claude")]])
        let panel = M.signInPanel(all, "Chrome", waiting["Chrome"]!)!
        XCTAssertEqual(panel.title, "Use your Chrome sign-ins for ChatGPT and Claude?")
        XCTAssertEqual(panel.lead, "macOS will ask for your Mac password next. Choose Allow.")
        XCTAssertEqual(panel.body, ["Engelbart copies only these apps' sign-ins from Chrome, and only reads from them, so you don't log in again. Not now lets you sign in to them here instead."])
        let claudeOff = M.tickRow(all, "chats", "Claude", false)
        XCTAssertEqual(M.signInPanel(claudeOff, "Chrome", waiting["Chrome"]!)?.title, "Use your Chrome sign-ins for ChatGPT?")
        XCTAssertTrue(M.signInPanel(claudeOff, "Chrome", waiting["Chrome"]!)!.body[0].hasSuffix("Not now lets you sign in to it here instead."))
        XCTAssertTrue(M.signInPanel(claudeOff, "Chrome", waiting["Chrome"]!)!.body[0].contains("this app's sign-in from Chrome"))

        let rows = waiting["Chrome"]!.map(\.row)
        func outcome(_ chatgpt: String?, _ claude: String?) -> KeychainOutcome {
            var signIns: [String: SignIn] = [:]
            if let chatgpt { signIns["ChatGPT"] = SignIn(status: chatgpt) }
            if let claude { signIns["Claude"] = SignIn(status: claude) }
            return M.keychainOutcome("Chrome", rows, signIns)
        }
        XCTAssertEqual(outcome("checking", "signed-in"), KeychainOutcome(done: false, title: "Waiting for macOS…", lines: ["Enter your Mac password in the macOS window, then choose Allow."], tone: "busy"))
        XCTAssertEqual(outcome("signed-in", "signed-in"), KeychainOutcome(done: true, title: "Signed in to ChatGPT and Claude", lines: ["Brought over from Chrome. You won't need to log in again."], tone: "ok"))
        let mixed = outcome("signed-in", "signed-out")
        XCTAssertEqual(mixed.tone, "warn")
        XCTAssertEqual(Array(mixed.lines.dropFirst()), ["Chrome isn't signed in to Claude. Sign in on its row to sign in here."])
        XCTAssertEqual(outcome("refused", "refused"), KeychainOutcome(done: true, title: "Not allowed", lines: ["macOS didn't allow it, so ChatGPT and Claude weren't brought over. Try again on their rows to be asked again, or Sign in to sign in here."], tone: "refused"))
        XCTAssertEqual(outcome("signed-in", nil).tone, "warn")

        let declined = ["ChatGPT": SignIn(status: "declined"), "Claude": SignIn(status: "declined")]
        XCTAssertEqual([M.ticked(all, "chats", "ChatGPT"), M.ticked(all, "chats", "Claude")], [true, true])
        XCTAssertEqual(M.unsignedWeb(all, declined, found, true).map(\.app), ["ChatGPT", "Claude"])
        XCTAssertFalse(M.signsInViaBrowser("Gmail", SignIn(status: "declined")))
        XCTAssertFalse(M.signsInViaBrowser("Gmail", SignIn(status: "refused", browser: "Chrome")))
        XCTAssertFalse(M.signsInViaBrowser("Gmail", SignIn(status: "no-browser")))
        XCTAssertTrue(M.signsInViaBrowser("Gmail", SignIn(status: "signed-out")))
        XCTAssertTrue(M.signsInViaBrowser("Gmail", nil))
        XCTAssertFalse(M.signsInViaBrowser("ChatGPT", nil))

        let ticking = M.newlyTickedWeb(start, one)
        XCTAssertEqual(M.signInsToCheck(true, ticking), ticking)
        XCTAssertEqual(M.signInsToCheck(false, ticking), [])
        XCTAssertEqual(M.waitingWhile(true, waiting), waiting)
        XCTAssertEqual(M.waitingWhile(false, waiting), [:])
    }

    func testGoogleInTheBrowserAndProfiles() {
        let found: JSONValue = ["apps": ["Google Docs": ["found": true], "Gmail": ["found": true], "ChatGPT": ["found": true]], "sites": ["found": false], "github": ["found": false]]
        func l(_ app: String, _ signIn: SignIn?) -> RowLabel { M.rowLabel(app, found: found, signIn: signIn) }
        XCTAssertTrue(ConnectSources.signsInThroughBrowser("Gmail"))
        XCTAssertFalse(ConnectSources.signsInThroughBrowser("ChatGPT"))
        XCTAssertEqual(l("Gmail", SignIn(status: "browser", browser: "Chrome")), label("Sign in to Google in Chrome. It can take a minute to appear here.", "busy", here: true, another: true))
        XCTAssertEqual(l("ChatGPT", SignIn(status: "browser", browser: "Chrome")), label("Sign in to ChatGPT in Chrome. It can take a minute to appear here.", "busy", here: true))
        XCTAssertEqual(M.waitingIn("Google", "Brave"), "Sign in to Google in Brave. It can take a minute to appear here.")
        XCTAssertEqual([M.signInName("Google Docs"), M.signInName("Gemini"), M.signInName("Claude")], ["Google", "Google", "Claude"])
        XCTAssertEqual(l("Gmail", SignIn(status: "no-browser")), label("", "", signIn: true))
        XCTAssertEqual(l("Gmail", SignIn(status: "refused", browser: "Chrome")), label("macOS didn't allow it", "error", retry: true, signIn: true))
        XCTAssertEqual(l("Gmail", SignIn(status: "declined")), label("", "", signIn: true))
        XCTAssertEqual(l("Gmail", SignIn(status: "signed-out")), label("", "", signIn: true))
        XCTAssertEqual(l("Gmail", SignIn(status: "rejected")), label("Google refused this sign-in", "error", retry: true))
        XCTAssertEqual(l("Google Docs", SignIn(status: "rejected")).text, "Google refused this sign-in")
        XCTAssertEqual(l("ChatGPT", SignIn(status: "signed-in", browser: "Chrome", profile: "Work")), label("✓ Signed in from Chrome · Work", "ok"))
        XCTAssertEqual(M.keychainOutcome("Chrome", [sa("email", "Gmail")], ["Gmail": SignIn(status: "refused")]).lines,
                       ["macOS didn't allow it, so Gmail wasn't brought over. Try again on its row to be asked again, or Sign in to sign in here."])
        XCTAssertEqual(M.keychainOutcome("Chrome", [sa("email", "Gmail")], ["Gmail": SignIn(status: "signed-out")]).lines, ["Chrome isn't signed in to Gmail. Sign in on its row to sign in in Chrome."])

        let profiles = [SignInProfile(browserId: "chrome", browser: "Chrome", profileId: "Default", name: "Me", email: "me@example.com", keychain: true),
                        SignInProfile(browserId: "chrome", browser: "Chrome", profileId: "Profile 1", name: "Work", email: "", keychain: true)]
        let waiting = M.waitForYes([:], [YesInput(id: "chats", app: "ChatGPT", browser: "Chrome", note: "macOS will ask", profiles: profiles, route: "")])
        XCTAssertEqual(waiting["Chrome"], [YesRow(id: "chats", app: "ChatGPT", note: "macOS will ask", profiles: profiles)])
        let picks = M.tickRow(M.initialPicks(found), "chats", "ChatGPT", true)
        let panel = M.signInPanel(picks, "Chrome", waiting["Chrome"]!, 1)!
        XCTAssertEqual(panel.profiles.map(\.name), ["Me", "Work"])
        XCTAssertEqual(panel.chosen, 1)
        XCTAssertEqual(panel.title, "Use your Chrome sign-ins for ChatGPT?")
        XCTAssertTrue(panel.body[0].hasPrefix("More than one Chrome profile is signed in. Pick the one to use; Engelbart remembers it. "))
        XCTAssertEqual(M.signInPanel(picks, "Chrome", waiting["Chrome"]!)?.chosen, 0)
        var fox0 = profiles[0]; fox0.browserId = "firefox"; fox0.browser = "Firefox"; fox0.profileId = "abcd.default-release"; fox0.name = "default-release"; fox0.email = ""; fox0.keychain = false
        let fox = [fox0, profiles[1]]
        let foxWaiting = M.waitForYes([:], [YesInput(id: "chats", app: "ChatGPT", browser: "Firefox", profiles: fox)])["Firefox"]!
        let mixed = M.signInPanel(picks, "Firefox", foxWaiting, 0)!
        XCTAssertEqual(mixed.lead, "")
        XCTAssertEqual(mixed.title, "Use your Firefox sign-ins for ChatGPT?")
        XCTAssertTrue(mixed.body[0].hasPrefix("More than one browser profile is signed in."))
        XCTAssertEqual(M.signInPanel(picks, "Firefox", foxWaiting, 1)?.lead, "macOS will ask for your Mac password next. Choose Allow.")
        let single = M.waitForYes([:], [YesInput(id: "chats", app: "ChatGPT", browser: "Chrome", note: "macOS will ask", profiles: [profiles[0]])])
        XCTAssertEqual(M.signInPanel(picks, "Chrome", single["Chrome"]!)?.profiles, [])
    }

    func testSignInGate() {
        let found: JSONValue = ["apps": ["Obsidian": ["found": true], "ChatGPT": ["found": true, "signedIn": true]], "sites": ["found": false], "github": ["found": false]]
        var picks = M.initialPicks(found)
        picks = M.tickRow(picks, "notes", "Google Docs", true)
        picks = M.tickRow(picks, "email", "Gmail", true)
        picks = M.tickRow(picks, "chats", "ChatGPT", true)
        picks = M.tickRow(picks, "chats", "Claude", true)
        picks = M.tickRow(picks, "notes", "Evernote", true)
        let signIns = ["Google Docs": SignIn(status: "signed-out"), "Gmail": SignIn(status: "no-browser"), "Claude": SignIn(status: "signed-in", browser: "Chrome")]
        let unsigned = M.unsignedWeb(picks, signIns, found, true)
        XCTAssertEqual(unsigned, [sa("notes", "Google Docs"), sa("email", "Gmail")])
        let gate = M.signInGate(unsigned)!
        XCTAssertEqual(gate.title, "Google Drive and Gmail need you to sign in")
        XCTAssertEqual(gate.groups, [[sa("notes", "Google Docs"), sa("email", "Gmail")]])
        XCTAssertEqual(gate.lines, [])
        XCTAssertEqual(gate.body, "Sign in opens Google's sign-in in your browser. Leave them out to start without them.")
        XCTAssertTrue(gate.canSignIn)
        XCTAssertTrue(M.signInGate([sa("chats", "Perplexity")])!.body.hasPrefix("Sign in opens its sign-in page in a small window here. Leave it out"))
        let two = M.signInGate(unsigned + [sa("chats", "Perplexity")])!
        XCTAssertEqual(two.title, "Google Drive, Gmail and Perplexity need you to sign in")
        XCTAssertEqual(two.lines, ["Google Drive and Gmail: one sign-in.", "Perplexity."])
        XCTAssertTrue(two.body.hasPrefix("Sign in opens Google's sign-in in your browser, and the others in a small window here."))
        for status in ["no-browser", "declined", "refused"] {
            let window = M.signInGate(unsigned, ["Google Docs": SignIn(status: status), "Gmail": SignIn(status: status)])!
            XCTAssertEqual(window.lines, [], status)
            XCTAssertTrue(window.body.hasPrefix("Sign in opens its sign-in page in a small window here. Leave them out"), status)
        }
        XCTAssertTrue(M.signInGate(unsigned, [:], platform: "win32")!.body.hasPrefix("Sign in opens its sign-in page in a small window here."))
        XCTAssertTrue(M.signInGate(unsigned + [sa("chats", "Perplexity")], [:], platform: "linux")!.body.hasPrefix("Sign in opens each sign-in page in a small window here."))
        XCTAssertEqual(M.signInGate([sa("chats", "Perplexity")])?.title, "Perplexity needs you to sign in")
        let left = unsigned.reduce(picks) { M.tickRow($0, $1.id, $1.app, false) }
        XCTAssertEqual(M.unsignedWeb(left, signIns, found, true), [])
        XCTAssertEqual([M.ticked(left, "notes", "Google Docs"), M.ticked(left, "email", "Gmail"), M.ticked(left, "chats", "Claude"), M.ticked(left, "notes", "Obsidian")], [false, false, true, true])
        var signedIn = signIns
        for app in ConnectSources.sharesSignIn("Google Docs") { signedIn[app] = SignIn(status: "signed-in") }
        XCTAssertEqual(ConnectSources.sharesSignIn("Google Docs"), ["Google Docs", "Google Meet", "Gmail", "Gemini"])
        XCTAssertEqual(M.unsignedWeb(picks, signedIn, found, true), [])
        XCTAssertNil(M.signInGate([]))
        var checking = signedIn; checking["Claude"] = SignIn(status: "checking")
        XCTAssertEqual(M.unsignedWeb(picks, checking, found, true), [])
        XCTAssertEqual(M.unsignedWeb(picks, signIns, found, false), [])
    }

    func testTheWindowsModel() {
        let found: JSONValue = ["apps": ["Obsidian": ["found": true], "Claude Code": ["found": true], "ChatGPT": ["found": true]], "sites": ["found": true], "github": ["found": false]]
        let start = M.initialPicks(found)
        XCTAssertEqual(start.picks, ["notes": true, "transcripts": false, "email": false, "chats": true, "sites": true, "papers": false, "code": false, "other": false])
        XCTAssertEqual(start.open, ["notes": true])
        XCTAssertEqual([start.apps["chats"]?["ChatGPT"], start.apps["chats"]?["Claude Code"], start.apps["notes"]?["Obsidian"], start.apps["sites"]?[M.browserRow]], [false, true, true, true])
        XCTAssertEqual(M.pickedApps(start.picks, start.apps), ["Obsidian", "Claude Code"])
        XCTAssertEqual(M.subOf("notes", start), "Obsidian")
        XCTAssertEqual(M.subOf("transcripts", start), "nothing picked")
        XCTAssertEqual(M.subOf("sites", start), M.browserRow)
        XCTAssertEqual(M.rowSub("ChatGPT"), "")
        XCTAssertEqual(M.rowSub("Apple Notes"), "macOS will ask")
        XCTAssertEqual(M.rowSub("Obsidian"), "")
        XCTAssertEqual(M.permissionsFor(["Granola", "Apple Notes", "Claude"]), PermissionsFor(web: ["Claude"], recall: ["Claude"], connectors: ["Granola"], notes: true))
        XCTAssertEqual(M.permissionsOf(start, consent: true), Permissions(files: true, browser: true, recall: false, notes: false))
        let withChatGPT = M.tickRow(start, "chats", "ChatGPT", true)
        XCTAssertEqual(withChatGPT.picks["chats"], true)
        XCTAssertEqual(M.permissionsOf(withChatGPT, consent: false, notes: true), Permissions(files: false, browser: false, recall: true, notes: true))
        let more = ["Notion", "Apple Notes", "Google Docs"].reduce(withChatGPT) { M.tickRow($0, "notes", $1, true) }
        XCTAssertEqual(M.consentFor(more), ["Obsidian", "Google Docs", "ChatGPT", "Claude Code", "your browser history"])
        XCTAssertEqual(M.consentFor(M.tickAll(start, found, false)), [])
        let seen: JSONValue = ["apps": ["Obsidian": ["found": true, "where": "~/Vault"], "ChatGPT": ["found": true, "signedIn": true, "where": "signed in to Engelbart"],
                                        "Perplexity": ["found": true, "signedIn": false, "where": "Sign in to add"], "Cursor": ["found": false], "Evernote": ["found": false]]]
        XCTAssertEqual(M.rowLabel("Obsidian", found: seen), label("~/Vault", ""))
        XCTAssertEqual(M.rowLabel("Cursor", found: seen), label("Not found", "muted"))
        XCTAssertEqual(M.rowLabel("Cursor", found: seen, folder: "~/Work"), label("~/Work", ""))
        XCTAssertEqual(M.rowLabel("ChatGPT", found: seen), label("signed in to Engelbart", ""))
        XCTAssertEqual(M.rowLabel("Perplexity", found: seen), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Evernote", found: seen), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Notion", found: seen), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Zotero", found: seen), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Zotero", found: ["apps": ["Zotero": ["found": true, "where": "~/Zotero (sign in to read it)"]]]), label("~/Zotero (sign in to read it)", ""))
        XCTAssertEqual(M.rowLabel("Codex", found: seen), label("Not found", "muted"))
        XCTAssertFalse(M.foundRow(seen, "notes", "Evernote"))
        XCTAssertEqual(M.rowLabel("Granola", found: seen), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Granola", found: seen, connectors: ["Granola": ["pending": true]]), label("Waiting for Granola sign-in…", "busy"))
        XCTAssertEqual(M.rowLabel("Notion", found: seen, connectors: ["Notion": ["connected": true]]), label("signed in", ""))
        XCTAssertEqual(M.rowLabel("Apple Notes", notes: "asking"), label("macOS is asking you…", "busy"))
        XCTAssertEqual(M.groupState(start, "notes"), "some")
        XCTAssertEqual(M.groupState(start, "sites"), "all")
        XCTAssertEqual(M.groupState(start, "transcripts"), "none")
        let offObsidian = M.tickRow(start, "notes", "Obsidian", false)
        XCTAssertEqual(offObsidian.picks["notes"], false)
        XCTAssertEqual(M.groupState(offObsidian, "notes"), "none")
        XCTAssertEqual(M.choicesOf(picks: offObsidian.picks, apps: offObsidian.apps)["sources"]?["notes"]?["apps"], [])
        let notesOff = M.tickGroup(start, "notes", found)
        XCTAssertEqual(notesOff.picks["notes"], false)
        XCTAssertFalse(notesOff.apps["notes"]!.values.contains(true))
        let notesOn = M.tickGroup(notesOff, "notes", found)
        XCTAssertEqual(M.choicesOf(picks: notesOn.picks, apps: notesOn.apps)["sources"]?["notes"]?["apps"], ["Obsidian"])
        let nothing = M.tickGroup(start, "transcripts", found)
        XCTAssertEqual(nothing.picks["transcripts"], false)
        XCTAssertEqual(nothing.open["transcripts"], true)
        let withRepos = found.with("github", ["found": true, "where": "signed in"]).with("localRepos", [["path": "/Users/me/a", "sessions": 3], ["path": "/Users/me/b", "sessions": 1]])
        let code = M.initialPicks(withRepos)
        XCTAssertEqual(code.apps["code"]?["GitHub"], true)
        XCTAssertEqual(M.localPicked(code), [])
        XCTAssertEqual(M.groupState(code, "code"), "some")
        let oneRepo = M.tickRepo(code, "/Users/me/a", true)
        XCTAssertEqual(M.localPicked(oneRepo), ["/Users/me/a"])
        XCTAssertEqual(M.subOf("code", oneRepo), "GitHub, 1 local repo")
        XCTAssertEqual(M.groupState(oneRepo, "code"), "all")
        let allCode = M.tickGroup(M.tickGroup(code, "code", withRepos), "code", withRepos)
        XCTAssertEqual(M.localPicked(allCode), ["/Users/me/a", "/Users/me/b"])
        XCTAssertEqual(allCode.apps["code"]?["GitHub"], true)
        XCTAssertTrue(M.allPicked(M.tickAll(code, withRepos), withRepos))
        XCTAssertFalse(M.allPicked(code, withRepos))
        let sent = M.choicesOf(picks: start.picks, apps: start.apps, folders: ["papers": ["/p"]], repos: ["a/b"], custom: " skip drafts ", permissions: ["files": false, "recall": false], provider: "openai", projectId: "p1")
        XCTAssertEqual(sent["sources"]?["notes"], ["on": true, "apps": ["Obsidian"], "folders": [], "repos": []])
        XCTAssertEqual(sent["permissions"], ["files": false, "browser": true, "recall": false, "notes": false])
        XCTAssertEqual(sent["computer"], false)
        XCTAssertEqual(sent["provider"], "openai")
        XCTAssertEqual(sent["projectId"], "p1")
        XCTAssertEqual(sent["custom"], "skip drafts")
        XCTAssertEqual(M.statusOf(["status": "done", "notes": 3, "items": 2]).text, "✓ 5 added")
        XCTAssertEqual(M.statusOf(["status": "waiting", "notes": 0, "items": 0]), JobStatus(text: "needs you", done: false, waiting: true))
        XCTAssertEqual(M.statusOf(["kind": "survey", "status": "running"]).text, "looking…")
        XCTAssertEqual(M.statusOf(["kind": "recall", "status": "done"]).text, "✓ remembered")
        XCTAssertFalse(M.allEnded([["status": "done"], ["status": "queued"]]))
        XCTAssertEqual(M.needView(["app": "ChatGPT", "kind": "signin"]).action, "Log in")
        XCTAssertEqual(M.needView(["app": "Granola", "kind": "connector"]).action, "Log in")
        XCTAssertEqual(M.needView(["app": "Apple Notes", "kind": "permission"]).action, "Allow")
        XCTAssertEqual(M.statusOf(["status": "stopped", "skipped": true, "notes": 0, "items": 0]).text, "skipped")
        let jobs: [JSONValue] = [["id": "a", "status": "done"], ["id": "b", "status": "queued"], ["id": "c", "status": "running"], ["id": "d", "status": "waiting"], ["id": "e", "status": "failed"]]
        XCTAssertEqual(M.runningFirst(jobs).map { J.str($0["id"]) }, ["c", "d", "b", "a", "e"])
        let going: JSONValue = ["thinking": true, "activity": "Reading what you picked", "jobs": [["id": "s1", "kind": "survey", "label": "Looking through ChatGPT", "status": "running", "activity": "Opened chatgpt.com"],
                                                                                              ["id": "s2", "kind": "import", "label": "Notes", "status": "waiting"], ["id": "m", "kind": "memory", "status": "running"]]]
        XCTAssertEqual(M.workLine(going, tick: 0), WorkLine(lead: "Reading what you picked…", agent: WorkLineAgent(id: "s1", label: "Looking through ChatGPT", doing: "Opened chatgpt.com", place: "1 of 2", waiting: false)))
        XCTAssertEqual(M.workLine(going, tick: 1)?.agent, WorkLineAgent(id: "s2", label: "Notes", doing: "needs you", place: "2 of 2", waiting: true))
        XCTAssertNil(M.workLine(["thinking": false, "jobs": [["status": "done", "kind": "import"]]]))
        let inbox = M.connectInbox([
            ["id": "1", "projectId": "p1", "needs": [["app": "Claude", "kind": "signin"]], "jobs": [], "created": "2026-10-08T00:00:00Z"],
            ["id": "2", "projectId": nil, "done": true, "needs": [], "jobs": [["status": "done", "notes": 2, "items": 0]], "memory": ["status": "saved"], "counts": ["notes": 2, "items": 0]],
            ["id": "3", "projectId": "p1", "done": true, "needs": [], "jobs": [["status": "running", "notes": 0, "items": 0]], "memory": ["status": "waiting"]],
            ["id": "4", "projectId": "p2", "needs": [["app": "Claude", "kind": "signin"]], "jobs": []],
        ], projectId: "p1")
        XCTAssertEqual(inbox.map { [$0.sessionId, $0.did] }, [["1", "Claude needs you to sign in"], ["2", "Library connected · 2 added · MEMORY.md saved"]])
        XCTAssertEqual(inbox[0].id, "connect:1")
        XCTAssertEqual(inbox[0].name, "Connect your library")
        XCTAssertEqual(M.memoryLine(["status": "saved", "removed": 2]).text, "Saved · 2 secrets masked")
        XCTAssertEqual(M.dockLine(["needs": [["app": "ChatGPT", "kind": "signin"]], "jobs": []]), DockLine(tone: "warn", short: "Needs you", text: "ChatGPT needs you to sign in"))
        XCTAssertEqual(M.dockLine(["needs": [], "done": true, "jobs": [["status": "running", "notes": 0, "items": 0], ["status": "done", "notes": 1, "items": 0]], "memory": ["status": "waiting"]]),
                       DockLine(tone: "busy", short: "Importing 1/2", text: "Importing · 1 of 2 done"))
        XCTAssertEqual(M.dockLine(["needs": [], "done": true, "jobs": [["status": "done", "notes": 4, "items": 1]], "memory": ["status": "saved"], "counts": ["notes": 4, "items": 1]]),
                       DockLine(tone: "done", short: "Library", text: "Library connected · 5 added · MEMORY.md saved"))
    }

    func testPeriod() {
        XCTAssertEqual(ConnectSources.periods.map(\.label), ["the past 6 months", "the past year", "all time"])
        XCTAssertEqual(ConnectSources.defaultPeriodDays, 365)
        XCTAssertEqual(M.choicesOf(picks: [:], apps: [:], days: 365)["days"], 365)
        XCTAssertEqual(M.choicesOf(picks: [:], apps: [:], days: 182)["days"], 182)
        XCTAssertEqual(M.choicesOf(picks: [:], apps: [:], days: nil)["days"], .null, "all time is sent as null")
        XCTAssertEqual(M.choicesOf(picks: [:], apps: [:], days: 90)["days"], .null)
    }

    func testWorkRow() {
        func row(_ job: JSONValue) -> [String] {
            var full: [String: JSONValue] = ["kind": "import", "apps": [], "notes": 0, "items": 0]
            for (k, v) in job.object ?? [:] { full[k] = v }
            let view = M.workRow(.object(full))
            return [view.title, view.sub, view.status.text]
        }
        XCTAssertEqual(row(["source": "transcripts", "apps": ["Google Meet", "Zoom"], "label": "Meeting transcripts: Google Meet, Zoom", "status": "running"]), ["Google Meet and Zoom", "Meeting transcripts", "Adding…"])
        XCTAssertEqual(row(["source": "chats", "apps": ["ChatGPT"], "label": "AI chats: chats about Engelbart product work", "status": "running", "items": 65]), ["ChatGPT", "Chats about Engelbart product work", "Adding · 65 so far"])
        XCTAssertEqual(row(["source": "sites", "label": "Websites", "status": "queued"]), ["Websites", "Pages from your browser history", "Queued"])
        XCTAssertEqual(row(["source": "notes", "apps": ["Obsidian"], "label": "Obsidian: mathetic and Obsidian Vault", "status": "done", "notes": 11]), ["Obsidian", "Mathetic and Obsidian Vault", "✓ 11 added"])
        XCTAssertEqual(row(["source": "papers", "label": "Papers", "status": "failed"]), ["Papers", "", "Failed"])
        XCTAssertEqual(M.workRow(["kind": "survey", "apps": ["Overleaf"], "label": "Looking through Overleaf", "status": "running"]).status.text, "Looking…")
        for text in ["Notes: Google Drive", "Notes: Google Docs"] {
            let r = M.workRow(["kind": "import", "source": "notes", "apps": ["Google Docs"], "label": .string(text), "status": "running"])
            XCTAssertEqual(r.title, "Google Drive")
            XCTAssertEqual(r.sub, "Notes", text)
        }
        XCTAssertEqual(M.workRow(["kind": "import", "source": "notes", "apps": ["Obsidian", "Google Docs"], "label": "Notes: Obsidian, Google Drive"]).title, "Obsidian and Google Drive")
    }

    func testFootLineAndChatStatus() {
        let jobs: [JSONValue] = [
            ["kind": "import", "label": "Notes: Obsidian", "status": "running", "notes": 1, "items": 0],
            ["kind": "import", "label": "AI chats", "status": "queued", "notes": 0, "items": 0],
            ["kind": "survey", "label": "Looking through Overleaf", "status": "running", "notes": 0, "items": 0],
            ["kind": "survey", "label": "Looking through Notion", "status": "done", "notes": 0, "items": 0],
            ["kind": "memory", "label": "MEMORY.md", "status": "queued", "notes": 0, "items": 0],
        ]
        func imp(_ label: String?, _ status: String = "running", _ more: [String: JSONValue] = [:]) -> JSONValue {
            var o: [String: JSONValue] = ["kind": "import", "status": .string(status), "notes": 0, "items": 0]
            if let label { o["label"] = .string(label) }
            for (k, v) in more { o[k] = v }
            return .object(o)
        }
        func foot(_ jobs: [JSONValue], _ needs: [JSONValue] = []) -> String { M.footLine(["jobs": .array(jobs), "needs": .array(needs)]) }
        XCTAssertEqual(foot(jobs), "Bringing in Notes: Obsidian and AI chats")
        XCTAssertEqual(foot([imp("Zotero papers")]), "Bringing in Zotero papers")
        XCTAssertEqual(foot([imp("AI chats", "queued"), imp("Zotero papers"), imp("Websites", "done")]), "Bringing in Zotero papers and AI chats")
        XCTAssertEqual(foot([imp("Zotero papers"), imp("AI chats"), imp("Websites", "queued"), imp("Meeting transcripts", "waiting")]), "Bringing in Zotero papers and 3 more")
        XCTAssertEqual(foot([imp("Bringing in your Obsidian notes")]), "Bringing in your Obsidian notes")
        XCTAssertEqual(foot([imp("", "running", ["apps": ["Google Docs"]])]), "Bringing in Google Drive")
        XCTAssertEqual(foot([imp(nil, "running", ["source": "papers"])]), "Bringing in Papers")
        XCTAssertEqual(foot(Array(jobs[2...])), "Looking through your apps")
        XCTAssertEqual(foot([jobs[3], imp("Zotero papers", "done"), jobs[4]]), "Everything's in")
        XCTAssertEqual(foot([]), "")
        XCTAssertEqual(foot([imp("Zotero papers")], [["app": "Google Docs", "kind": "connector"]]), "Bringing in Zotero papers · Google Drive needs you")
        XCTAssertEqual(foot(Array(jobs[2...]), [["app": "Zotero"], ["app": "GitHub"], ["app": "Zotero", "kind": "permission"]]), "Looking through your apps · Zotero and GitHub need you")
        XCTAssertEqual(foot([jobs[3]], [["app": "Zotero"], ["app": "GitHub"], ["app": "Notion"], ["app": "Gmail", "closed": true]]), "Everything's in · Zotero and 2 more need you")
        XCTAssertEqual(foot([jobs[3]], [[:]]), "Everything's in · 1 step needs you")
        XCTAssertEqual(foot([jobs[3]], [[:], ["app": "Zotero"]]), "Everything's in · 2 steps need you")
        XCTAssertEqual(M.chatStatus(["thinking": true, "activity": "Reading what the surveys found", "jobs": .array(jobs)]), "Reading what the surveys found…")
        XCTAssertEqual(M.chatStatus(["waiting": true, "jobs": .array(jobs), "needs": []]), "Looking through Overleaf…")
        XCTAssertEqual(M.chatStatus(["waiting": true, "jobs": [jobs[2].with("status", "waiting")], "needs": [[:]]]), "Waiting for your sign-in…")
        XCTAssertEqual(M.chatStatus(["jobs": .array(jobs)]), "")
        XCTAssertEqual(M.needView(["app": "ChatGPT", "kind": "signin"]).hint, "Opens in your browser · read-only")
    }

    func testOffTheMac() {
        let apps: JSONValue = ["Google Docs": ["found": true], "Gmail": ["found": true], "ChatGPT": ["found": true, "signedIn": true], "Cursor": ["found": true]]
        let windows: JSONValue = ["platform": "win32", "apps": apps, "sites": ["found": false], "github": ["found": false]]
        XCTAssertFalse(M.copiesSignIns("win32"))
        XCTAssertFalse(M.copiesSignIns("linux"))
        XCTAssertTrue(M.copiesSignIns("darwin"))
        XCTAssertTrue(M.copiesSignIns(nil))
        XCTAssertEqual(M.rowLabel("ChatGPT", found: windows).text, "signed in to Engelbart")
        XCTAssertEqual(M.rowLabel("Gmail", found: windows), label("Needs sign-in", "muted"))
        XCTAssertEqual(M.rowLabel("Gmail", found: windows, signIn: SignIn(status: "signed-out")), label("", "", signIn: true))
        let picks = M.initialPicks(windows)
        XCTAssertTrue(M.ticked(M.tickAll(picks, windows), "notes", "Google Docs"))
        XCTAssertTrue(M.foundRow(windows, "notes", "Google Docs"))
        let gmail = M.tickRow(picks, "email", "Gmail", true)
        XCTAssertTrue(M.ticked(gmail, "email", "Gmail"))
        XCTAssertEqual(M.unsignedWeb(gmail, ["Gmail": SignIn(status: "signed-out")], windows).map(\.app), ["Gmail"])
        XCTAssertFalse(M.signsInViaBrowser("Gmail", nil, platform: "win32"))
        XCTAssertFalse(M.signsInViaBrowser("Gmail", SignIn(status: "signed-out"), platform: "win32"))
        XCTAssertTrue(M.signsInViaBrowser("Gmail", nil, platform: "darwin"))
    }

    func testGmailAndGoogleDrive() {
        let found: JSONValue = ["apps": ["Gmail": ["found": true], "Google Docs": ["found": true]]]
        let start = M.initialPicks(found)
        XCTAssertEqual(start.apps["email"]?["Gmail"], false)
        XCTAssertEqual(start.apps["notes"]?["Google Docs"], false)
        XCTAssertEqual(start.picks["email"], false)
        XCTAssertTrue(M.neverTicked.contains("Gmail"))
        let ticked = M.tickRow(M.initialPicks(["apps": ["Gmail": ["found": true]]]), "email", "Gmail", true)
        let on = ticked.apps.flatMap { id, rows in rows.filter(\.value).map { "\(id):\($0.key)" } }
        XCTAssertEqual(on, ["email:Gmail"])
        XCTAssertTrue(M.consentFor(ticked).contains("Gmail"))
        XCTAssertEqual(M.choicesOf(picks: ticked.picks, apps: ticked.apps)["sources"]?["email"], ["on": true, "apps": ["Gmail"], "folders": [], "repos": []])
        let none = M.tickAll(M.initialPicks(found), found, false)
        let all = M.tickAll(none, found, true)
        XCTAssertEqual(all.apps["email"]?["Gmail"], false)
        XCTAssertEqual(all.apps["notes"]?["Google Docs"], true)
        XCTAssertTrue(M.allPicked(all, found))
        let header = M.tickGroup(none, "email", found)
        XCTAssertEqual(header.apps["email"]?["Gmail"], false)
        XCTAssertEqual(header.open["email"], true)
        let own = M.tickRow(all, "email", "Gmail", true)
        XCTAssertEqual(M.tickAll(own, found, false).apps["email"]?["Gmail"], false)
        XCTAssertEqual(M.tickGroup(own, "email", found).apps["email"]?["Gmail"], false)
        // Google Drive starts unticked; its row, the Notes header and Select all tick it.
        let f2: JSONValue = ["apps": ["Gmail": ["found": true, "signedIn": true], "Google Docs": ["found": true, "signedIn": true], "Obsidian": ["found": true]]]
        let s2 = M.initialPicks(f2)
        XCTAssertEqual([s2.apps["notes"]?["Google Docs"], s2.apps["notes"]?["Obsidian"], s2.apps["email"]?["Gmail"]], [false, true, false])
        XCTAssertTrue(M.startUnticked.contains("Google Docs") && M.startUnticked.contains("Gmail"))
        XCTAssertEqual(M.neverTicked, ["Gmail"])
        let cleared = M.tickGroup(s2, "notes", f2)
        XCTAssertEqual(M.groupState(cleared, "notes"), "none")
        let h2 = M.tickGroup(cleared, "notes", f2)
        XCTAssertEqual([h2.apps["notes"]?["Google Docs"], h2.apps["notes"]?["Obsidian"]], [true, true])
        XCTAssertFalse(M.allPicked(s2, f2))
        XCTAssertTrue(M.allPicked(M.tickAll(s2, f2, true), f2))
        XCTAssertEqual(M.rowLabel("Google Docs", found: .bool(true), signIn: SignIn(status: "signed-in")), label("✓ Signed in", "ok"))
    }

    func testFolderPanelAndLabel() {
        let names = ["Desktop", "Documents", "Downloads", "Google Drive"].map { GuardedFolder(id: $0, name: $0) }
        let panel = M.folderPanel(names)!
        XCTAssertEqual(panel.folders, "Desktop, Documents, Downloads and Google Drive")
        XCTAssertEqual(panel.names, ["Desktop", "Documents", "Downloads", "Google Drive"])
        XCTAssertEqual(panel.title, "Let Engelbart read your folders?")
        XCTAssertEqual(panel.lead, "Engelbart looks here for papers, documents and repos related to your project. Without this, files saved on your Mac are left out.")
        XCTAssertEqual(panel.note, "macOS will ask once for each folder.")
        XCTAssertEqual(panel.ask, "Choose Allow on each.")
        XCTAssertEqual(panel.tip, "macOS only asks once. You can change it later in System Settings → Privacy & Security → Files and Folders.")
        let repos = M.folderPanel([GuardedFolder(id: "Documents", name: "Documents")], papers: false)!
        XCTAssertEqual(repos.title, "Let Engelbart read your Documents?")
        XCTAssertEqual(repos.lead, "Engelbart looks here for repos related to your project. Without this, repos saved in it are left out.")
        XCTAssertEqual([repos.note, repos.ask], ["macOS will ask once.", "Choose Allow."])
        XCTAssertNil(M.folderPanel([]))
        XCTAssertEqual(M.rowTip(ConnectSources.localPDFs), panel.tip)
        let folders = ["Desktop", "Documents", "Downloads"].map { GuardedFolder(id: $0, name: $0) }
        XCTAssertEqual(M.folderAccessLabel(asking: true, folders: folders), label("Waiting for macOS…", "busy"))
        XCTAssertEqual(M.folderAccessLabel(answers: ["Desktop": "allowed", "Documents": "allowed", "Downloads": "allowed"], folders: folders), label("✓ Desktop, Documents, Downloads", "ok"))
        XCTAssertEqual(M.folderAccessLabel(answers: ["Desktop": "allowed", "Documents": "allowed", "Downloads": "denied"], folders: folders), label("✓ Desktop, Documents · Downloads not allowed", "ok"))
        XCTAssertEqual(M.folderAccessLabel(answers: ["Desktop": "denied", "Documents": "denied", "Downloads": "denied"], folders: folders), label("Desktop, Documents and Downloads not allowed", "muted"))
        XCTAssertNil(M.folderAccessLabel(folders: folders))
        XCTAssertEqual(M.choicesOf(picks: ["papers": true], apps: [:], folders: ["papers": ["/Users/ada/Documents/P"]], picked: ["/Users/ada/Documents/P"])["picked"], ["/Users/ada/Documents/P"])
        XCTAssertNil(M.choicesOf(picks: [:], apps: [:])["picked"])
    }

    func testShownName() {
        let start = M.initialPicks(["apps": ["Obsidian": ["found": true]]])
        let ticked = M.tickRow(start, "notes", "Google Docs", true)
        XCTAssertEqual(ticked.apps["notes"]?["Google Docs"], true)
        XCTAssertNil(ticked.apps["notes"]?["Google Drive"])
        XCTAssertEqual(M.subOf("notes", ticked), "Obsidian, Google Drive")
        XCTAssertTrue(J.strs(M.choicesOf(picks: ticked.picks, apps: ticked.apps)["sources"]?["notes"]?["apps"]).contains("Google Docs"))
        for kind in ["signin", "connector", "permission", "folder", "code"] {
            let view = M.needView(["app": "Google Docs", "kind": .string(kind)])
            XCTAssertFalse("\(view.title) \(view.action) \(view.hint)".contains("Google Docs"), kind)
        }
        XCTAssertTrue(M.needView(["app": "Google Docs", "kind": "signin"]).title.contains("Google Drive"))
        XCTAssertEqual(M.rowTip("Google Docs"), "Docs, Sheets, Slides and files")
        XCTAssertEqual(M.rowTip("Notion"), "")
        let panel = M.signInPanel(ticked, "Chrome", [YesRow(id: "notes", app: "Google Docs")])!
        XCTAssertEqual(panel.title, "Use your Chrome sign-ins for Google Drive?")
        XCTAssertEqual(panel.rows.map(\.row), [sa("notes", "Google Docs")])
        XCTAssertFalse(M.rowLabel("Google Docs").text.contains("Google Docs"))
        XCTAssertEqual(Logos.toolFile("Google Docs"), "google-drive")
        XCTAssertNil(Logos.toolFile("Google Drive"))
    }

    func testSignInWindowClosedAndShownSignIn() {
        let state = picksWith([("notes", "Google Docs"), ("email", "Gmail"), ("chats", "Gemini"), ("chats", "Claude")])
        let signIns = ["Google Docs": SignIn(status: "signing", was: SignIn(status: "refused", browser: "Chrome")), "Gmail": SignIn(status: "refused", browser: "Chrome"),
                       "Gemini": SignIn(status: "declined"), "Claude": SignIn(status: "declined")]
        let out = M.signInWindowClosed(state, "Google Docs", signIns)
        for (id, app) in [("notes", "Google Docs"), ("email", "Gmail"), ("chats", "Gemini")] { XCTAssertFalse(M.ticked(out.state, id, app), app) }
        XCTAssertTrue(M.ticked(out.state, "chats", "Claude"))
        XCTAssertFalse(M.ticked(out.state, "transcripts", "Google Meet"))
        XCTAssertEqual(out.signIns["Google Docs"], SignIn(status: "signed-out"))
        XCTAssertEqual(out.signIns["Gmail"], SignIn(status: "signed-out"))
        XCTAssertEqual(out.signIns["Gemini"], signIns["Gemini"])
        XCTAssertEqual(out.signIns["Claude"], signIns["Claude"])
        XCTAssertNil(M.shownSignIn(out.state, "notes", "Google Docs", out.signIns))
        XCTAssertEqual(state, picksWith([("notes", "Google Docs"), ("email", "Gmail"), ("chats", "Gemini"), ("chats", "Claude")]), "the state given is not changed")
        let fresh = M.signInWindowClosed(picksWith([("chats", "ChatGPT")]), "ChatGPT", ["ChatGPT": SignIn(status: "signing")])
        XCTAssertNil(fresh.signIns["ChatGPT"])
        XCTAssertFalse(M.ticked(fresh.state, "chats", "ChatGPT"))

        let closed = M.signInWindowClosed(picksWith([("chats", "Perplexity")]), "Perplexity", ["Perplexity": SignIn(status: "signing", was: SignIn(status: "refused", browser: "Chrome"))])
        let again = M.tickRow(closed.state!, "chats", "Perplexity", true)
        XCTAssertEqual(M.newlyTickedWeb(closed.state, again), [sa("chats", "Perplexity")])
        XCTAssertEqual(M.rowLabel("Perplexity", found: ["apps": ["Perplexity": ["found": true]]], signIn: M.shownSignIn(again, "chats", "Perplexity", closed.signIns)), label("", "", signIn: true))

        var all: [String: SignIn] = [:]
        for app in ConnectSources.sharesSignIn("Google Docs") { all[app] = SignIn(status: "signed-in") }
        let found: JSONValue = ["apps": ["Gmail": ["found": true], "Google Docs": ["found": true]]]
        let drive = picksWith([("notes", "Google Docs")])
        XCTAssertEqual(M.rowLabel("Google Docs", found: found, signIn: M.shownSignIn(drive, "notes", "Google Docs", all)), label("✓ Signed in", "ok"))
        XCTAssertNil(M.shownSignIn(drive, "email", "Gmail", all))
        XCTAssertEqual(M.rowLabel("Gmail", found: found, signIn: M.shownSignIn(M.tickRow(drive, "email", "Gmail", true), "email", "Gmail", all)), label("✓ Signed in", "ok"))
        let waiting = ["ChatGPT": SignIn(status: "checking"), "Claude": SignIn(status: "refused", browser: "Chrome")]
        let none = M.initialPicks(["apps": [:]])
        XCTAssertNil(M.shownSignIn(none, "chats", "ChatGPT", waiting))
        XCTAssertNil(M.shownSignIn(none, "chats", "Claude", waiting))
        XCTAssertEqual(M.shownSignIn(M.tickRow(none, "chats", "Claude", true), "chats", "Claude", waiting), waiting["Claude"])
        XCTAssertEqual(M.sources.suffix(2).map(\.id), ["code", "other"])
    }

    func testOpensSignInAndChainRules() {
        XCTAssertTrue(M.opensSignIn("signed-out", fresh: true))
        XCTAssertTrue(M.opensSignIn("no-browser", fresh: true))
        XCTAssertFalse(M.opensSignIn("signed-in", fresh: true))
        XCTAssertFalse(M.opensSignIn("", fresh: true))
        XCTAssertFalse(M.opensSignIn(nil, fresh: true))
        XCTAssertFalse(M.opensSignIn("signed-out", fresh: true, consent: false))
        XCTAssertFalse(M.opensSignIn("signed-out", fresh: true, still: false))
        XCTAssertFalse(M.opensSignIn("signed-out"))
        XCTAssertFalse(M.opensSignIn("no-browser", fresh: false))
        XCTAssertTrue(M.opensSignIn("refused"))
        let rows = [sa("chats", "Claude"), sa("notes", "Google Docs"), sa("email", "Gmail"), sa("chats", "Gemini"), sa("chats", "Grok")]
        let state = picksWith(rows.map { ($0.id, $0.app) })
        XCTAssertEqual(M.signInChain(rows, state: state).map(\.app), ["Claude", "Google Docs", "Grok"])
        XCTAssertEqual(M.signInChain(rows, signIns: ["Gmail": SignIn(status: "signed-in")], state: state).map(\.app), ["Claude", "Grok"])
        XCTAssertEqual(M.signInChain(rows, state: M.tickRow(state, "chats", "Claude", false)).map(\.app), ["Google Docs", "Grok"])
        XCTAssertEqual(M.signInChain(rows, state: state, consent: false), [])
        XCTAssertEqual(M.signInChain([], state: state), [])
        let three = [sa("notes", "Google Docs"), sa("email", "Gmail"), sa("chats", "Claude")]
        let s3 = picksWith(three.map { ($0.id, $0.app) })
        XCTAssertEqual(M.signInChain(three, signIns: ["Google Docs": SignIn(status: "browser", browser: "Chrome")], state: s3).map(\.app), ["Claude"])
        XCTAssertEqual(M.signInChain(three, signIns: ["Google Docs": SignIn(status: "signing")], state: s3).map(\.app), ["Claude"])
        XCTAssertEqual(M.rowLabel("ChatGPT", found: ["apps": ["ChatGPT": ["found": true]]], signIn: SignIn(status: "checking")), label("Checking…", "busy"))
    }

    func testGrantLastTurnAndDockNeverYourAnswer() {
        let chat: [JSONValue] = [["role": "agent", "opener": true, "text": "Found 1 vault."], ["role": "agent", "grant": ["rows": [], "answered": ["allowed": [], "skipped": []]]],
                                 ["role": "agent", "text": "Which folders?", "ask": ["title": "Which folders?"]], ["role": "agent", "notice": true, "text": "Couldn't connect to Linear. Skipped."]]
        XCTAssertEqual(ConnectLibraryModel.lastTurn(chat), 2)
        XCTAssertEqual(ConnectLibraryModel.lastTurn(chat + [["role": "user", "text": "Research"]]), 4)
        XCTAssertEqual(M.dockLine(["needs": [], "done": false, "thinking": false, "chat": .array(chat), "jobs": []]), DockLine(tone: "busy", short: "Importing", text: "Importing your library…"))
        XCTAssertEqual(M.needView(["app": "ChatGPT", "kind": "signin-here", "where": "here"]), NeedView(title: "Sign in to ChatGPT", action: "Sign in inside Engelbart", hint: ""))
        XCTAssertEqual(M.needView(["app": "Google Docs", "kind": "signin-here", "where": "browser", "browser": "Chrome"]).action, "Sign in in Chrome")
    }

    func testLogTime() {
        XCTAssertEqual(M.logTime("nonsense"), "")
        let at = "2026-10-08T14:02:00.000Z"
        let date = ISO8601DateFormatter().date(from: "2026-10-08T14:02:00Z")!
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        XCTAssertEqual(M.logTime(at), String(format: "%02d:%02d", parts.hour!, parts.minute!))
    }
}
