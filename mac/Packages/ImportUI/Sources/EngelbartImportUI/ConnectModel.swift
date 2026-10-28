import Foundation
import EngelbartCore
import EngelbartConnect

// Port of src/renderer/model/connect.js: Connect your library (2026-10-07; Claude Design "Connect Library.dc.html"), the
// window's model. Pure: ConnectLibraryView and the dock ask what is ticked, what a row says beside it, what goes to main
// (src/main/connect), how an import's progress reads, what a step the agents hand the person says, and what the dock
// shows. The sources and apps are EngelbartConnect.ConnectSources (shared/connect-sources.cjs).
//
// MATH-114 (2026-10-09): the choose screen as the mockup's grouped list. Each source is a group whose header ticks its
// rows (tri-state); a row says at its right how the app is reached and where it stands; ticking is the consent (a
// connector's sign-in, macOS's Apple Notes prompt, a folder for a local app that was not found). Websites is one row (the
// browser's history), Code two (GitHub, and the repositories on this Mac). One checkbox lets the agents read with the
// person's own subscription (files and browser); asking an assistant what it remembers is ticking that assistant.
//
// Sessions, jobs, needs and what main found (`connect-detect`) stay JSONValue: they are main's snapshots, read as the
// renderer read them (J).

/// A row of the choose screen: the source it is listed under and the app (connect.js `{ id, app }`).
public struct SourceApp: Equatable, Hashable, Sendable {
    public var id: String
    public var app: String
    public init(id: String, app: String) { self.id = id; self.app = app }
}

/// The repositories ticked for Code, in the order they were first seen (a JS object's key order).
public struct OrderedTicks: Equatable, Sendable {
    public private(set) var keys: [String] = []
    private var values: [String: Bool] = [:]
    public init() {}
    public subscript(key: String) -> Bool {
        get { values[key] ?? false }
        set { if values[key] == nil { keys.append(key) }; values[key] = newValue }
    }
    public func has(_ key: String) -> Bool { values[key] != nil }
    public mutating func remove(_ key: String) { values[key] = nil; keys.removeAll { $0 == key } }
    public var entries: [(String, Bool)] { keys.map { ($0, values[$0] ?? false) } }
    public var anyOn: Bool { values.values.contains(true) }
}

/// The choose screen's ticks (connect.js state): `apps[source][row]`, the repositories on this Mac, the groups open, and
/// `picks` derived (a source is on exactly when one of its rows is ticked).
public struct Picks: Equatable, Sendable {
    public var apps: [String: [String: Bool]] = [:]
    public var local = OrderedTicks()
    public var open: [String: Bool] = [:]
    public private(set) var picks: [String: Bool] = [:]
    public init(apps: [String: [String: Bool]] = [:], local: OrderedTicks = OrderedTicks(), open: [String: Bool] = [:]) {
        self.apps = apps; self.local = local; self.open = open
        self = ConnectModel.derive(self)
    }
    mutating func setPicks(_ value: [String: Bool]) { picks = value }
}

/// A web app's sign-in as checked when it was ticked (main's connect-signin-check, and the screen's own states):
/// status 'checking' | 'signing' | 'browser' | 'signed-in' | 'refused' | 'declined' | 'rejected' | 'signed-out' |
/// 'no-browser'; `was` what it was before a window or a wait in the browser.
public struct SignIn: Equatable, Sendable {
    public var status: String
    public var browser: String
    public var profile: String?
    private var wasBox: [SignIn]
    public var was: SignIn? { get { wasBox.first } set { wasBox = newValue.map { [$0] } ?? [] } }
    public init(status: String, browser: String = "", profile: String? = nil, was: SignIn? = nil) {
        self.status = status; self.browser = browser; self.profile = profile; self.wasBox = was.map { [$0] } ?? []
    }
    /// Main's answer ({ status, browser, profile? }) → a sign-in, or nil when it says nothing.
    public init?(json: JSONValue?) {
        guard let status = json?["status"]?.string, !status.isEmpty else { return nil }
        self.init(status: status, browser: J.str(json?["browser"]), profile: json?["profile"]?.string.flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// What a row says at its right (rowLabel): its words, their tone ('' | 'muted' | 'busy' | 'error' | 'ok') and the links
/// beside them (Try again, Sign in, Sign in here instead, Use another account).
public struct RowLabel: Equatable, Sendable {
    public var text: String
    public var tone: String
    public var retry = false
    public var signIn = false
    public var here = false
    public var another = false
    public init(text: String, tone: String, retry: Bool = false, signIn: Bool = false, here: Bool = false, another: Bool = false) {
        self.text = text; self.tone = tone; self.retry = retry; self.signIn = signIn; self.here = here; self.another = another
    }
}

/// A browser profile that holds a sign-in (main's connect-signin-note `profiles`).
public struct SignInProfile: Equatable, Sendable {
    public var browserId: String
    public var browser: String
    public var profileId: String
    public var name: String
    public var email: String
    public var keychain: Bool
    public init(browserId: String, browser: String, profileId: String, name: String, email: String = "", keychain: Bool = true) {
        self.browserId = browserId; self.browser = browser; self.profileId = profileId; self.name = name; self.email = email; self.keychain = keychain
    }
    public init(json: JSONValue) {
        self.init(browserId: J.str(json["browserId"]), browser: J.str(json["browser"]), profileId: J.str(json["profileId"]), name: J.str(json["name"]),
                  email: J.str(json["email"]), keychain: J.truthy(json["keychain"]))
    }
}

/// A row waiting for the Keychain modal's Continue (waitForYes): note macOS will be asked, the profiles to pick from, the
/// route ('browser' when Continue goes on to Google's Sign in).
public struct YesRow: Equatable, Sendable {
    public var id: String
    public var app: String
    public var note: String?
    public var profiles: [SignInProfile]
    public var route: String?
    public init(id: String, app: String, note: String? = nil, profiles: [SignInProfile] = [], route: String? = nil) {
        self.id = id; self.app = app; self.note = note; self.profiles = profiles; self.route = route
    }
    public var row: SourceApp { SourceApp(id: id, app: app) }
}

/// A row to wait on (waitForYes's input): the row with the browser main named.
public struct YesInput: Equatable, Sendable {
    public var id: String, app: String, browser: String
    public var note: String?, profiles: [SignInProfile], route: String?
    public init(id: String, app: String, browser: String, note: String? = nil, profiles: [SignInProfile] = [], route: String? = nil) {
        self.id = id; self.app = app; self.browser = browser; self.note = note; self.profiles = profiles; self.route = route
    }
}

public struct SignInPanel: Equatable, Sendable {
    public var browser: String
    public var rows: [YesRow]
    public var profiles: [SignInProfile]
    public var chosen: Int
    public var title: String
    public var lead: String
    public var body: [String]
}

public struct SignInGate: Equatable, Sendable {
    public var title: String
    public var groups: [[SourceApp]]
    public var lines: [String]
    public var canSignIn: Bool
    public var body: String
}

public struct FolderPanel: Equatable, Sendable {
    public var title: String
    public var lead: String
    public var names: [String]
    public var note: String
    public var ask: String
    public var folders: String
    public var tip: String
}

/// A folder macOS guards (main's connect-folders-needed): `{ id, name }`.
public struct GuardedFolder: Equatable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct KeychainOutcome: Equatable, Sendable {
    public var done: Bool
    public var title: String
    public var lines: [String]
    public var tone: String
}

public struct Permissions: Equatable, Sendable {
    public var files: Bool, browser: Bool, recall: Bool, notes: Bool
    public init(files: Bool, browser: Bool, recall: Bool, notes: Bool) { self.files = files; self.browser = browser; self.recall = recall; self.notes = notes }
    public var json: JSONValue { ["files": .bool(files), "browser": .bool(browser), "recall": .bool(recall), "notes": .bool(notes)] }
}

public struct PermissionsFor: Equatable, Sendable {
    public var web: [String], recall: [String], connectors: [String], notes: Bool
}

/// A job's place in the progress list (statusOf) and a row of onboarding's "Bringing everything in" (workRow).
public struct JobStatus: Equatable, Sendable {
    public var text: String
    public var done: Bool
    public var failed = false
    public var waiting = false
    public var going = false
    public init(text: String, done: Bool, failed: Bool = false, waiting: Bool = false, going: Bool = false) {
        self.text = text; self.done = done; self.failed = failed; self.waiting = waiting; self.going = going
    }
}

public struct WorkRow: Equatable, Sendable { public var title: String; public var sub: String; public var status: JobStatus }

public struct WorkLineAgent: Equatable, Sendable {
    public var id: String, label: String, doing: String, place: String, waiting: Bool
}
public struct WorkLine: Equatable, Sendable { public var lead: String; public var agent: WorkLineAgent? }

public struct NeedView: Equatable, Sendable { public var title: String; public var action: String; public var hint: String }

public struct DockLine: Equatable, Sendable {
    public var tone: String
    public var short: String
    public var text: String
}

public struct InboxEntry: Equatable, Sendable {
    public var id: String, kind: String, sessionId: String, workspaceId: String?, name: String, did: String, at: String?
}

public enum ConnectModel {
    public static let sources = ConnectSources.sources
    /// The AI assistants that remember the person (connect-sources' `memory`): found, they still start unticked.
    public static let memoryApps = ConnectSources.recallApps(ConnectSources.appOrder)
    /// Apps that start unticked even when found (2026-10-11): Gmail holds what other people wrote, so ticking it is its own yes.
    public static let neverTicked = ["Gmail"]
    /// Gmail, and Google Drive ('Google Docs'), which is the person's whole Drive and as personal as their mail. Unlike
    /// Gmail, Drive is still ticked by its group's header and Select all (it is not NEVER_TICKED).
    public static let startUnticked = neverTicked + ["Google Docs"]
    /// Websites' one row (2026-10-14: "Saved URLs" in place of "Browser history"), and Code's second (the first is GitHub).
    public static let browserRow = "Saved URLs"
    public static let localRepos = "Local repos"
    public static let localPDFs = ConnectSources.localPDFs
    /// What a row says when it needs a sign-in before it can be read (2026-10-09, board "Now-3a-Fix").
    public static let needsSignIn = "Needs sign-in"

    /// The rows a group's header ticks, in order.
    public static func rowsOf(_ sourceId: String) -> [String] {
        if sourceId == "sites" { return [browserRow] }
        if sourceId == "code" { return ["GitHub", localRepos] }
        return ConnectSources.sourceOf(sourceId)?.apps ?? []
    }

    /// Whether a web app's sign-in can be copied from the person's browser here (2026-10-12): on the Mac only.
    public static func copiesSignIns(_ platform: String?) -> Bool { platform == nil || platform == "" || platform == "darwin" }

    /// The name a sign-in goes by: "Google" for every app sharing Google's (Gmail, Google Drive…), any other its shown name.
    public static func signInName(_ app: String) -> String { ConnectSources.signsInThroughBrowser(app) ? "Google" : ConnectSources.shownName(app) }

    // Where Sign in has gone to Engelbart's window instead of the person's browser.
    static let windowNext = ["declined", "refused", "no-browser", "rejected"]

    /// Whether Sign in for `app` waits for its sign-in in the person's browser (2026-10-12): Google's, on the Mac, until the
    /// person turned the browser's sign-ins down or there is none to read; every other sign-in is Engelbart's own window.
    public static func signsInViaBrowser(_ app: String, _ signIn: SignIn? = nil, platform: String? = "darwin") -> Bool {
        copiesSignIns(platform) && ConnectSources.signsInThroughBrowser(app) && !windowNext.contains(signIn?.status ?? "")
    }

    /// Whether a row was found (on this Mac, signed in to, connected): what the header and Select all tick.
    public static func foundRow(_ found: JSONValue?, _ sourceId: String, _ row: String) -> Bool {
        guard let found, J.truthy(found) else { return false }
        if sourceId == "sites" { return J.truthy(found["sites"]?["found"]) }
        if sourceId == "code" { return row == "GitHub" ? J.truthy(found["github"]?["found"]) : !J.arr(found["localRepos"]).isEmpty }
        return J.truthy(found["apps"]?[row]?["found"])
    }

    /// Whether a row is ticked. Local repos is, when any repository on this Mac (or folder picked for Code) is.
    public static func ticked(_ state: Picks?, _ sourceId: String, _ row: String) -> Bool {
        guard let state else { return false }
        if sourceId == "code" && row == localRepos { return state.local.anyOn }
        return state.apps[sourceId]?[row] ?? false
    }

    // Each source is on exactly when one of its rows is ticked: never on with none (appsOf would read that as every app).
    static func derive(_ state: Picks) -> Picks {
        var next = state
        var picks: [String: Bool] = [:]
        for source in sources { picks[source.id] = rowsOf(source.id).contains { ticked(state, source.id, $0) } }
        next.setPicks(picks)
        return next
    }

    /// Where the choose screen starts: a row is ticked when it was found, except the assistants that remember the person,
    /// Gmail and Google Drive, and the repositories on this Mac. Nothing is open but the first ticked source.
    public static func initialPicks(_ found: JSONValue?) -> Picks {
        var apps: [String: [String: Bool]] = [:]
        for source in sources {
            var rows: [String: Bool] = [:]
            for row in rowsOf(source.id) where !(source.id == "code" && row == localRepos) {
                rows[row] = foundRow(found, source.id, row) && !memoryApps.contains(row) && !startUnticked.contains(row)
            }
            apps[source.id] = rows
        }
        var state = Picks(apps: apps)
        if let first = sources.first(where: { state.picks[$0.id] == true && !$0.apps.isEmpty }) { state.open = [first.id: true] }
        return state
    }

    /// A row ticked or not. Local repos ticks every repository found (`repos`: their paths), or none.
    public static func tickRow(_ state: Picks, _ sourceId: String, _ row: String, _ on: Bool, repos: [String] = []) -> Picks {
        var next = state
        if sourceId == "code" && row == localRepos {
            var local = OrderedTicks()
            for key in state.local.keys { local[key] = on }
            for dir in repos { local[dir] = on }
            next.local = local
            return derive(next)
        }
        next.apps[sourceId, default: [:]][row] = on
        return derive(next)
    }

    /// A repository on this Mac (or a folder picked for Code) ticked or not.
    public static func tickRepo(_ state: Picks, _ dir: String, _ on: Bool) -> Picks {
        var next = state
        next.local[dir] = on
        return derive(next)
    }

    /// A group's header: 'all' of its rows ticked, 'some', or 'none'.
    public static func groupState(_ state: Picks?, _ sourceId: String) -> String {
        let rows = rowsOf(sourceId)
        let n = rows.filter { ticked(state, sourceId, $0) }.count
        return n == 0 ? "none" : n == rows.count ? "all" : "some"
    }

    static func repoPaths(_ found: JSONValue?) -> [String] { J.arr(found?["localRepos"]).map { J.str($0["path"]) } }

    /// A group's header clicked: with anything ticked, everything goes off; with nothing, its found rows come on (Local
    /// repos: every repository found), except Gmail. A group with none of those opens instead.
    public static func tickGroup(_ state: Picks, _ sourceId: String, _ found: JSONValue?) -> Picks {
        let rows = rowsOf(sourceId)
        let repos = repoPaths(found)
        if groupState(state, sourceId) != "none" { return rows.reduce(state) { tickRow($0, sourceId, $1, false) } }
        let on = rows.filter { foundRow(found, sourceId, $0) && !neverTicked.contains($0) }
        if on.isEmpty { var next = state; next.open[sourceId] = true; return next }
        return on.reduce(state) { tickRow($0, sourceId, $1, true, repos: repos) }
    }

    // What Select all and a group's header tick: a found row, but never Gmail.
    static func selectable(_ found: JSONValue?, _ sourceId: String, _ row: String) -> Bool { foundRow(found, sourceId, row) && !neverTicked.contains(row) }

    /// Select all: every found row of every group but Gmail; `false`: nothing (Gmail too).
    public static func tickAll(_ state: Picks, _ found: JSONValue?, _ on: Bool = true) -> Picks {
        let repos = repoPaths(found)
        return sources.reduce(state) { next, source in
            rowsOf(source.id).reduce(next) { acc, row in
                on ? (selectable(found, source.id, row) ? tickRow(acc, source.id, row, true, repos: repos) : acc) : tickRow(acc, source.id, row, false)
            }
        }
    }

    /// Whether every row Select all ticks is ticked (its button then says Clear).
    public static func allPicked(_ state: Picks?, _ found: JSONValue?) -> Bool {
        let rows = sources.flatMap { source in rowsOf(source.id).filter { selectable(found, source.id, $0) }.map { (source.id, $0) } }
        return !rows.isEmpty && rows.allSatisfy { ticked(state, $0.0, $0.1) }
    }

    /// The repository folders ticked for Code, sent as its `folders`.
    public static func localPicked(_ state: Picks?) -> [String] { (state?.local.entries ?? []).filter(\.1).map(\.0) }

    /// The apps of a source that are ticked (a source turned on with none ticked counts every app, as the design has it).
    public static func appsOf(_ sourceId: String, _ apps: [String: [String: Bool]]) -> [String] {
        guard let source = ConnectSources.sourceOf(sourceId) else { return [] }
        let chosen = source.apps.filter { apps[sourceId]?[$0] == true }
        return chosen.isEmpty ? source.apps : chosen
    }

    /// Every app picked, across the sources that are on.
    public static func pickedApps(_ picks: [String: Bool], _ apps: [String: [String: Bool]]) -> [String] {
        sources.filter { picks[$0.id] == true }.flatMap { appsOf($0.id, apps) }
    }

    static func reposCount(_ state: Picks?) -> String { let n = localPicked(state).count; return "\(n) local repo\(n == 1 ? "" : "s")" }

    /// What a group's header says after its name: the rows ticked as the person sees them, or "nothing picked".
    public static func subOf(_ sourceId: String, _ state: Picks?) -> String {
        let names = rowsOf(sourceId).filter { ticked(state, sourceId, $0) }.map { sourceId == "code" && $0 == localRepos ? reposCount(state) : ConnectSources.shownName($0) }
        return names.isEmpty ? "nothing picked" : names.joined(separator: ", ")
    }

    /// What a row says at its right, from how its app is reached and where it stands. "Not found" only for an app read
    /// from this Mac (MATH-144); an app in the cloud is "Needs sign-in" whether or not the Mac has its desktop app.
    public static func rowLabel(_ app: String, found: JSONValue? = nil, connectors: [String: JSONValue] = [:], notes: String = "", folder: String = "",
                                signIn: SignIn? = nil, keychain: Bool = false) -> RowLabel {
        let seen = found?["apps"]?[app]
        if !folder.isEmpty { return RowLabel(text: folder, tone: "") }
        guard let spec = ConnectSources.appOf(app) else { return RowLabel(text: "", tone: "") }
        switch spec.reach {
        case .connector:
            let status = connectors[app]
            if J.truthy(status?["connected"]) { return RowLabel(text: "signed in", tone: "") }
            if J.truthy(status?["pending"]) { return RowLabel(text: "Waiting for \(ConnectSources.shownName(app)) sign-in…", tone: "busy") }
            return RowLabel(text: needsSignIn, tone: "muted")
        case .automation:
            if notes == "allowed" { return RowLabel(text: "allowed", tone: "") }
            if notes == "asking" { return RowLabel(text: "macOS is asking you…", tone: "busy") }
            return notes.isEmpty ? RowLabel(text: "", tone: "") : RowLabel(text: notes, tone: "error")
        case .web:
            if let said = signInLabel(signIn, app: app, keychain: keychain) { return said }
            if J.truthy(seen?["signedIn"]) { return RowLabel(text: "signed in to Engelbart", tone: "") }
            return RowLabel(text: needsSignIn, tone: "muted")
        default:
            break
        }
        if J.truthy(seen?["found"]) && J.str(seen?["where"]) == "Sign in to add" { return RowLabel(text: needsSignIn, tone: "muted") }
        if J.truthy(seen?["found"]) { return RowLabel(text: J.str(seen?["where"]), tone: "") }
        return spec.reach == .signin ? RowLabel(text: needsSignIn, tone: "muted") : RowLabel(text: "Not found", tone: "muted")
    }

    /// "Sign in to Google in Chrome. It can take a minute to appear here."
    public static func waitingIn(_ name: String?, _ browser: String?) -> String {
        "Sign in to \((name ?? "").isEmpty ? "it" : name!) in \((browser ?? "").isEmpty ? "your browser" : browser!). It can take a minute to appear here."
    }

    /// A web app's sign-in as checked when it was ticked → its label, or nil.
    static func signInLabel(_ signIn: SignIn?, app: String = "", keychain: Bool = false) -> RowLabel? {
        guard let signIn, !signIn.status.isEmpty else { return nil }
        let google = ConnectSources.signsInThroughBrowser(app)
        switch signIn.status {
        case "checking": return RowLabel(text: keychain ? "Waiting for macOS…" : "Checking…", tone: "busy")
        case "signing": return RowLabel(text: "Signing in…", tone: "busy")
        case "browser": return RowLabel(text: waitingIn(signInName(app), signIn.browser), tone: "busy", here: true, another: google)
        case "signed-in":
            let text = signIn.browser.isEmpty ? "✓ Signed in" : "✓ Signed in from \(signIn.browser)\(signIn.profile.map { " · \($0)" } ?? "")"
            return RowLabel(text: text, tone: "ok")
        case "rejected": return RowLabel(text: "\(signInName(app)) refused this sign-in", tone: "error", retry: true)
        case "signed-out", "no-browser", "declined": return RowLabel(text: "", tone: "", signIn: true)
        case "refused": return RowLabel(text: "macOS didn't allow it", tone: "error", retry: true, signIn: true)
        default: return nil
        }
    }

    /// A row's sign-in once Engelbart's sign-in window was closed without signing in → what to put back, or nil: an old
    /// failure goes back to plain Sign in.
    public static func afterSignInWindowClosed(_ was: SignIn?) -> SignIn? {
        guard let was, !was.status.isEmpty else { return nil }
        if was.status == "refused" || was.status == "rejected" { return SignIn(status: "signed-out", browser: "") }
        return was
    }

    /// Engelbart's sign-in window for `app` closed by the person without signing in (2026-10-12, third run): a no, so `app`
    /// and every ticked app sharing its sign-in are unticked; their sign-ins put back with nothing stale.
    public static func signInWindowClosed(_ state: Picks?, _ app: String, _ signIns: [String: SignIn] = [:]) -> (state: Picks?, signIns: [String: SignIn]) {
        let group = ConnectSources.sharesSignIn(app)
        var next = state
        if state != nil {
            for source in sources { for other in source.apps where group.contains(other) && ticked(next, source.id, other) { next = tickRow(next!, source.id, other, false) } }
        }
        var after = signIns
        for other in group {
            let back = afterSignInWindowClosed(other == app ? signIns[app]?.was : signIns[other])
            if let back { after[other] = back } else if other == app { after[other] = nil }
        }
        return (next, after)
    }

    /// The sign-in a row says: only while the row is ticked.
    public static func shownSignIn(_ state: Picks?, _ id: String, _ app: String, _ signIns: [String: SignIn] = [:]) -> SignIn? {
        ticked(state, id, app) ? signIns[app] : nil
    }

    /// Whether a web app's sign-in check opens its sign-in by itself, in the chain (2026-10-12).
    public static func opensSignIn(_ status: String?, fresh: Bool = false, consent: Bool = true, still: Bool = true) -> Bool {
        if status == "refused" { return true }
        return fresh && consent && still && ["signed-out", "no-browser"].contains(status ?? "")
    }

    /// The sign-ins to open, in turn, for the rows turned down → one per sign-in group, in the order given, leaving out
    /// a row no longer ticked, one whose group is signed in and one whose group's sign-in is open already.
    public static func signInChain(_ rows: [SourceApp], signIns: [String: SignIn] = [:], state: Picks? = nil, consent: Bool = true) -> [SourceApp] {
        if !consent { return [] }
        var out: [SourceApp] = []
        for row in rows {
            if row.app.isEmpty || (state != nil && !ticked(state, row.id, row.app)) { continue }
            let group = ConnectSources.sharesSignIn(row.app)
            if group.contains(where: { signIns[$0]?.status == "signed-in" }) { continue }
            if group.contains(where: { ["browser", "signing"].contains(signIns[$0]?.status ?? "") }) { continue }
            if out.contains(where: { ConnectSources.signInGroup($0.app) == ConnectSources.signInGroup(row.app) }) { continue }
            out.append(row)
        }
        return out
    }

    /// The ticked web apps not signed in yet, before Bring these in (2026-10-11).
    public static func unsignedWeb(_ state: Picks?, _ signIns: [String: SignIn] = [:], _ found: JSONValue? = nil, _ consent: Bool = true) -> [SourceApp] {
        guard consent, let state else { return [] }
        var out: [SourceApp] = []
        for source in sources {
            for app in source.apps {
                guard ConnectSources.appOf(app)?.reach == .web, ConnectSources.signInCookies[app] != nil, ticked(state, source.id, app) else { continue }
                if J.truthy(found?["apps"]?[app]?["signedIn"]) { continue }
                let status = signIns[app]?.status
                if status == "signed-in" || status == "checking" { continue }
                if !out.contains(where: { $0.app == app }) { out.append(SourceApp(id: source.id, app: app)) }
            }
        }
        return out
    }

    /// The modal before a run with apps still not signed in, the apps grouped by the sign-in they share.
    public static func signInGate(_ rows: [SourceApp], _ signIns: [String: SignIn] = [:], platform: String? = "darwin") -> SignInGate? {
        if rows.isEmpty { return nil }
        var groups: [[SourceApp]] = []
        for row in rows {
            if let at = groups.firstIndex(where: { ConnectSources.signInGroup($0[0].app) == ConnectSources.signInGroup(row.app) }) { groups[at].append(row) } else { groups.append([row]) }
        }
        let names = rows.map { ConnectSources.shownName($0.app) }
        let title = "\(listed(names)) \(names.count == 1 ? "needs" : "need") you to sign in"
        let lines = groups.count > 1 ? groups.map { list in list.count > 1 ? "\(listed(list.map { ConnectSources.shownName($0.app) })): one sign-in." : "\(ConnectSources.shownName(list[0].app))." } : []
        let google = groups.filter { signsInViaBrowser($0[0].app, signIns[$0[0].app], platform: platform) }
        let whereTo = google.isEmpty ? "\(groups.count == 1 ? "its" : "each") sign-in page in a small window here"
            : google.count == groups.count ? "Google's sign-in in your browser" : "Google's sign-in in your browser, and the others in a small window here"
        let them = names.count == 1 ? "it" : "them"
        return SignInGate(title: title, groups: groups, lines: lines, canSignIn: !groups.isEmpty, body: "Sign in opens \(whereTo). Leave \(them) out to start without \(them).")
    }

    /// The web apps ticked in `after` that were not in `before`: each one's sign-in is checked when it is ticked.
    public static func newlyTickedWeb(_ before: Picks?, _ after: Picks?) -> [SourceApp] {
        var out: [SourceApp] = []
        for source in sources {
            for app in source.apps where ConnectSources.appOf(app)?.reach == .web {
                if ticked(after, source.id, app) && !ticked(before, source.id, app) { out.append(SourceApp(id: source.id, app: app)) }
            }
        }
        return out
    }

    /// Rows waiting for the person's yes before macOS is asked, by browser, with `rows` added.
    public static func waitForYes(_ waiting: [String: [YesRow]], _ rows: [YesInput]) -> [String: [YesRow]] {
        var out = waiting
        for input in rows {
            var list = out[input.browser] ?? []
            let row = YesRow(id: input.id, app: input.app, note: (input.note ?? "").isEmpty ? nil : input.note,
                             profiles: input.profiles.count > 1 ? input.profiles : [], route: (input.route ?? "").isEmpty ? nil : input.route)
            if !list.contains(where: { $0.app == input.app }) { list.append(row); out[input.browser] = list }
        }
        return out
    }

    /// The rows whose sign-in may be checked now: none while the consent is off (a check copies a browser's sign-ins).
    public static func signInsToCheck(_ consent: Bool, _ rows: [SourceApp]) -> [SourceApp] { consent ? rows : [] }

    /// The panels waiting for a yes, kept while the consent is on.
    public static func waitingWhile(_ consent: Bool, _ waiting: [String: [YesRow]]) -> [String: [YesRow]] { consent ? waiting : [:] }

    /// The panel shown before a browser's sign-ins are first used, naming every ticked app waiting on it, or nil.
    public static func signInPanel(_ state: Picks?, _ browser: String, _ rows: [YesRow] = [], _ chosen: Int = 0) -> SignInPanel? {
        let still = rows.filter { ticked(state, $0.id, $0.app) }
        if still.isEmpty { return nil }
        let apps = still.map { ConnectSources.shownName($0.app) }
        let profiles = still.first(where: { $0.profiles.count > 1 })?.profiles ?? []
        let pick = profiles.isEmpty ? nil : profiles[min(max(0, chosen), profiles.count - 1)]
        let from = pick?.browser ?? browser
        let keychain = pick.map(\.keychain) ?? true
        let one = apps.count == 1
        var prefix = ""
        if !profiles.isEmpty {
            let same = profiles.allSatisfy { $0.browser == profiles[0].browser }
            prefix = "More than one \(same ? "\(profiles[0].browser) profile" : "browser profile") is signed in. Pick the one to use; Engelbart remembers it. "
        }
        let body = "\(prefix)Engelbart copies only \(one ? "this app's sign-in" : "these apps' sign-ins") from \(from), and only reads from \(one ? "it" : "them"), so you don't log in again. Not now lets you sign in to \(one ? "it" : "them") here instead."
        return SignInPanel(browser: browser, rows: still, profiles: profiles, chosen: pick.flatMap { p in profiles.firstIndex(of: p) } ?? -1,
                           title: "Use your \(from) sign-ins for \(listed(apps))?",
                           lead: keychain ? "macOS will ask for your Mac password next. Choose Allow." : "", body: [body])
    }

    /* MATH-110: macOS's folder access, asked for once, before a run. */

    public static let folderAccessTip = "macOS only asks once. You can change it later in System Settings → Privacy & Security → Files and Folders."

    /// The panel before macOS asks to let Engelbart read its protected folders, or nil when none.
    public static func folderPanel(_ folders: [GuardedFolder], papers: Bool = true) -> FolderPanel? {
        let names = folders.map(\.name).filter { !$0.isEmpty }
        if names.isEmpty { return nil }
        let one = names.count == 1
        return FolderPanel(
            title: "Let Engelbart read your \(one ? names[0] : "folders")?",
            lead: papers ? "Engelbart looks here for papers, documents and repos related to your project. Without this, files saved on your Mac are left out."
                : "Engelbart looks here for repos related to your project. Without this, repos saved in \(one ? "it" : "these folders") are left out.",
            names: names, note: one ? "macOS will ask once." : "macOS will ask once for each folder.", ask: one ? "Choose Allow." : "Choose Allow on each.",
            folders: listed(names), tip: folderAccessTip)
    }

    /// The PDFs row's label while and after macOS is asked, or nil.
    public static func folderAccessLabel(asking: Bool = false, answers: [String: String]? = nil, folders: [GuardedFolder] = []) -> RowLabel? {
        if asking { return RowLabel(text: "Waiting for macOS…", tone: "busy") }
        guard let answers else { return nil }
        let named = folders.filter { answers[$0.id] != nil }
        if named.isEmpty { return nil }
        let allowed = named.filter { answers[$0.id] == "allowed" }.map(\.name)
        let denied = named.filter { answers[$0.id] != "allowed" }.map(\.name)
        let parts = [allowed.isEmpty ? "" : "✓ \(allowed.joined(separator: ", "))", denied.isEmpty ? "" : "\(listed(denied)) not allowed"].filter { !$0.isEmpty }
        return RowLabel(text: parts.joined(separator: " · "), tone: allowed.isEmpty ? "muted" : "ok")
    }

    /// The modal after Continue: how the check of each app it named went.
    public static func keychainOutcome(_ browser: String, _ rows: [SourceApp], _ signIns: [String: SignIn]) -> KeychainOutcome {
        func of(_ row: SourceApp) -> String { signIns[row.app]?.status ?? "signed-out" }
        if rows.contains(where: { of($0) == "checking" }) {
            return KeychainOutcome(done: false, title: "Waiting for macOS…", lines: ["Enter your Mac password in the macOS window, then choose Allow."], tone: "busy")
        }
        func names(_ status: String) -> [String] { rows.filter { of($0) == status }.map { ConnectSources.shownName($0.app) } }
        let signedIn = names("signed-in"), refused = names("refused")
        let missing = rows.filter { !["signed-in", "refused"].contains(of($0)) }.map { ConnectSources.shownName($0.app) }
        var lines: [String] = []
        func here(_ list: [String]) -> String {
            rows.filter { list.contains(ConnectSources.shownName($0.app)) }.allSatisfy { ConnectSources.signsInThroughBrowser($0.app) } ? "in \(browser)" : "here"
        }
        if !refused.isEmpty {
            lines.append("macOS didn't allow it, so \(listed(refused)) \(refused.count == 1 ? "wasn't" : "weren't") brought over. Try again on \(refused.count == 1 ? "its row" : "their rows") to be asked again, or Sign in to sign in here.")
        }
        if !missing.isEmpty { lines.append("\(browser) isn't signed in to \(listed(missing)). Sign in on \(missing.count == 1 ? "its row" : "their rows") to sign in \(here(missing)).") }
        if !signedIn.isEmpty {
            return KeychainOutcome(done: true, title: "Signed in to \(listed(signedIn))", lines: ["Brought over from \(browser). You won't need to log in again."] + lines, tone: lines.isEmpty ? "ok" : "warn")
        }
        return KeychainOutcome(done: true, title: refused.isEmpty ? "Nothing to bring over" : "Not allowed", lines: lines, tone: refused.isEmpty ? "warn" : "refused")
    }

    /// The line under a row's name, when it needs one: macOS asks before Apple Notes.
    public static func rowSub(_ app: String) -> String { app == "Apple Notes" ? "macOS will ask" : "" }

    /// What a row's tooltip adds about what the app brings in, or ''.
    public static func rowTip(_ app: String) -> String {
        if app == "Gmail" { return "Only the threads you approve" }
        if app == localPDFs { return folderAccessTip }
        return app == "Google Docs" ? "Docs, Sheets, Slides and files" : ""
    }

    /// What the one checkbox ("Use my … subscription to read these") covers of what is ticked.
    public static func consentFor(_ state: Picks?) -> [String] {
        var names: [String] = []
        for source in sources {
            for row in rowsOf(source.id) where ticked(state, source.id, row) {
                if source.id == "sites" { names.append("your browser history") }
                else if source.id == "code" { names.append(row == "GitHub" ? "GitHub" : reposCount(state)) }
                else if let reach = ConnectSources.appOf(row)?.reach, [.local, .web, .signin].contains(reach) { names.append(row) }
            }
        }
        return names
    }

    /// The permissions sent: files and the browser from the one checkbox, recall from an assistant ticked, Apple Notes from macOS.
    public static func permissionsOf(_ state: Picks?, consent: Bool = true, notes: Bool = false) -> Permissions {
        let apps = sources.flatMap { source in source.apps.filter { ticked(state, source.id, $0) } }
        return Permissions(files: consent, browser: consent, recall: !ConnectSources.recallApps(apps).isEmpty, notes: notes)
    }

    /// What the permissions card asks about for these picks.
    public static func permissionsFor(_ apps: [String]) -> PermissionsFor {
        var list: [String] = []
        for app in apps where !list.contains(app) { list.append(app) }
        return PermissionsFor(web: ConnectSources.webApps(list), recall: ConnectSources.recallApps(list),
                              connectors: list.filter { ConnectSources.appOf($0)?.reach == .connector }, notes: list.contains("Apple Notes"))
    }

    static let maxName = 200
    static let maxDescription = 4000

    /// The project Connect's librarian is told about: trimmed and clipped, or nil when both are empty.
    public static func projectOf(name: String?, description: String?) -> JSONValue? {
        let n = String((name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxName))
        let d = String((description ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxDescription))
        return n.isEmpty && d.isEmpty ? nil : ["name": .string(n), "description": .string(d)]
    }

    /// What `connect-start` is sent (choicesOf).
    public static func choicesOf(picks: [String: Bool], apps: [String: [String: Bool]], folders: [String: [String]] = [:], repos: [String] = [], picked: [String] = [],
                                 custom: String = "", permissions: [String: Bool] = [:], provider: String? = nil, projectId: String? = nil, workspaceId: String? = nil,
                                 project: (name: String, description: String)? = nil, days: Int? = nil) -> JSONValue {
        var sources: [String: JSONValue] = [:]
        for source in ConnectModel.sources {
            let on = picks[source.id] == true
            sources[source.id] = [
                "on": .bool(on),
                "apps": .array(on ? appsOf(source.id, apps).map(JSONValue.string) : []),
                "folders": .array(on ? (folders[source.id] ?? []).map(JSONValue.string) : []),
                "repos": .array(source.id == "code" && picks["code"] == true ? repos.map(JSONValue.string) : []),
            ]
        }
        let allowed = Permissions(files: permissions["files"] != false, browser: permissions["browser"] != false, recall: permissions["recall"] != false, notes: permissions["notes"] == true)
        var out: [String: JSONValue] = ["sources": .object(sources)]
        if !picked.isEmpty {
            var seen: [String] = []
            for p in picked where !seen.contains(p) { seen.append(p) }
            out["picked"] = .array(seen.map(JSONValue.string))
        }
        out["custom"] = .string(custom.trimmingCharacters(in: .whitespacesAndNewlines))
        out["computer"] = .bool(allowed.files)
        out["permissions"] = allowed.json
        out["days"] = ConnectSources.cleanDays(days).map { .number(Double($0)) } ?? .null
        if let provider, !provider.isEmpty { out["provider"] = .string(provider) }
        if let projectId, !projectId.isEmpty {
            out["projectId"] = .string(projectId)
            if let workspaceId, !workspaceId.isEmpty { out["workspaceId"] = .string(workspaceId) }
        }
        if let project, let value = projectOf(name: project.name, description: project.description) { out["project"] = value }
        return .object(out)
    }

    /// The onboarding session to pick up again: begun from onboarding, no project id, not stopped or put away.
    public static func resumable(_ list: [JSONValue]) -> JSONValue? {
        list.first { J.str($0["mode"]) == "onboarding" && !J.truthy($0["projectId"]) && !J.truthy($0["stopped"]) && !J.truthy($0["dismissed"]) }
    }

    /// Where what came in went (2026-10-11), for a session started from a project.
    public static func placedLine(_ session: JSONValue?) -> String {
        guard let session, J.truthy(session["projectId"]), let placed = session["placed"], J.truthy(placed["project"]) else { return "" }
        let project = J.int(placed["project"]), workspace = J.int(placed["workspace"])
        let head = "\(project) added to the project."
        if workspace == 0 { return head }
        return workspace < project ? "\(head) The first \(workspace) are also in this workspace." : "\(head) \(project == 1 ? "It is" : "They are") also in this workspace."
    }

    /// An import's place in the progress list.
    public static func statusOf(_ job: JSONValue) -> JobStatus {
        let n = J.int(job["notes"]) + J.int(job["items"])
        let added = "\(n) added"
        let status = J.str(job["status"])
        if J.truthy(job["skipped"]) { return JobStatus(text: "skipped", done: true) }
        switch J.str(job["kind"]) {
        case "survey":
            if status == "done" { return JobStatus(text: "looked", done: true) }
            if status == "failed" { return JobStatus(text: "could not look", done: true, failed: true) }
            if status == "stopped" { return JobStatus(text: "stopped", done: true) }
            if status == "waiting" { return JobStatus(text: "needs you", done: false, waiting: true) }
            return JobStatus(text: status == "running" ? "looking…" : "queued", done: false)
        case "recall":
            if status == "done" { return JobStatus(text: "✓ remembered", done: true) }
            if status == "failed" { return JobStatus(text: "failed", done: true, failed: true) }
            if status == "stopped" { return JobStatus(text: "stopped", done: true) }
            if status == "waiting" { return JobStatus(text: "needs you", done: false, waiting: true) }
            return JobStatus(text: status == "running" ? "asking…" : "queued", done: false)
        default:
            if status == "done" { return JobStatus(text: "✓ \(added)", done: true) }
            if status == "failed" { return JobStatus(text: n > 0 ? "stopped after \(added)" : "failed", done: true, failed: true) }
            if status == "stopped" { return JobStatus(text: n > 0 ? "stopped · \(added)" : "stopped", done: true) }
            if status == "waiting" { return JobStatus(text: n > 0 ? "needs you · \(added)" : "needs you", done: false, waiting: true) }
            if status == "running" { return JobStatus(text: n > 0 ? "importing… \(added)" : "importing…", done: false) }
            return JobStatus(text: "queued", done: false)
        }
    }

    /// Whether every job has ended.
    public static func allEnded(_ jobs: [JSONValue]) -> Bool { jobs.allSatisfy { statusOf($0).done } }

    /// The jobs the progress list shows: the work, without MEMORY.md's own.
    public static func workJobs(_ jobs: [JSONValue]) -> [JSONValue] { jobs.filter { !["memory", "redact"].contains(J.str($0["kind"])) } }

    // What each source is, under a row of onboarding's "Bringing everything in" when its label says nothing more.
    static let workSubs = ["notes": "Notes", "transcripts": "Meeting transcripts", "email": "Email threads", "chats": "AI chats", "sites": "Pages from your browser history", "papers": "Papers", "code": "Repositories"]

    /// A row of onboarding's "Bringing everything in" (2026-10-09, David's mockup).
    public static func workRow(_ job: JSONValue) -> WorkRow {
        let label = J.str(job["label"])
        let at = label.firstIndex(of: ":")
        let head = (at.map { String(label[..<$0]) } ?? label).trimmingCharacters(in: .whitespaces)
        let tail = at.map { String(label[label.index(after: $0)...]).trimmingCharacters(in: .whitespaces) } ?? ""
        let ids = J.strs(job["apps"]).filter { !$0.isEmpty }
        let apps = ids.map(ConnectSources.shownName)
        let title = !apps.isEmpty ? listed(apps) : (head.isEmpty ? label : head)
        let own = !tail.isEmpty && tail != apps.joined(separator: ", ") && tail != ids.joined(separator: ", ") && tail != title ? tail : ""
        let kind = J.str(job["kind"])
        let kindSub = kind == "survey" ? "Looking through it" : kind == "recall" ? "What it remembers about you" : workSubs[J.str(job["source"])] ?? ""
        let sub = !own.isEmpty ? own.prefix(1).uppercased() + own.dropFirst() : kindSub != title ? kindSub : ""
        let n = J.int(job["notes"]) + J.int(job["items"])
        let status = J.str(job["status"])
        let going = status == "running"
        var out: JobStatus
        if J.truthy(job["skipped"]) { out = JobStatus(text: "Skipped", done: true) }
        else if status == "done" { out = JobStatus(text: kind == "import" ? "✓ \(n) added" : kind == "recall" ? "✓ Remembered" : "✓ Looked", done: true) }
        else if status == "failed" { out = JobStatus(text: n > 0 ? "Stopped after \(n)" : "Failed", done: true, failed: true) }
        else if status == "stopped" { out = JobStatus(text: n > 0 ? "Stopped · \(n) added" : "Stopped", done: true) }
        else if status == "waiting" { out = JobStatus(text: "Needs you", done: false, waiting: true) }
        else if going { out = JobStatus(text: kind == "import" ? (n > 0 ? "Adding · \(n) so far" : "Adding…") : kind == "recall" ? "Asking…" : "Looking…", done: false) }
        else { out = JobStatus(text: "Queued", done: false) }
        out.going = going
        return WorkRow(title: title, sub: sub, status: out)
    }

    /// The jobs still going first (2026-10-08: "show the ones still running at the top"), running before queued, then the
    /// ended, each group in its order.
    public static func runningFirst(_ jobs: [JSONValue]) -> [JSONValue] {
        func rank(_ job: JSONValue) -> Int { statusOf(job).done ? 2 : J.str(job["status"]) == "queued" ? 1 : 0 }
        return jobs.enumerated().sorted { a, b in rank(a.element) != rank(b.element) ? rank(a.element) < rank(b.element) : a.offset < b.offset }.map(\.element)
    }

    static func leadOf(_ session: JSONValue) -> String {
        let activity = J.str(session["activity"])
        let text = "\(activity.isEmpty ? "Thinking" : activity)…"
        return text.hasSuffix("……") ? String(text.dropLast()) : text
    }

    /// The line under the chat, as Claude Code shows its subagents: what the librarian is doing, and the subagents still at
    /// work, one at a time. `tick` turns the cycle.
    public static func workLine(_ session: JSONValue?, tick: Int = 0) -> WorkLine? {
        guard let session else { return nil }
        let busy = workJobs(J.arr(session["jobs"])).filter { ["running", "waiting"].contains(J.str($0["status"])) }
        let lead = J.truthy(session["thinking"]) ? leadOf(session) : ""
        if lead.isEmpty && busy.isEmpty { return nil }
        let at = busy.isEmpty ? 0 : ((tick % busy.count) + busy.count) % busy.count
        guard !busy.isEmpty else { return WorkLine(lead: lead, agent: nil) }
        let job = busy[at]
        let waiting = J.str(job["status"]) == "waiting"
        let activity = J.str(job["activity"])
        return WorkLine(lead: lead, agent: WorkLineAgent(id: J.str(job["id"]), label: J.str(job["label"]), doing: waiting ? "needs you" : (activity.isEmpty ? statusOf(job).text : activity),
                                                          place: busy.count > 1 ? "\(at + 1) of \(busy.count)" : "", waiting: waiting))
    }

    /// What an import brings in, as the foot names it.
    static func importName(_ job: JSONValue) -> String {
        let label = J.str(job["label"]).trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^bringing in\s+"#, with: "", options: [.regularExpression, .caseInsensitive]).trimmingCharacters(in: .whitespaces)
        if !label.isEmpty { return label }
        let apps = J.strs(job["apps"]).filter { !$0.isEmpty }.map(ConnectSources.shownName)
        if !apps.isEmpty { return listed(apps) }
        let source = J.str(job["source"])
        return ConnectSources.sourceOf(source)?.label ?? (source.isEmpty ? "a source" : source)
    }

    /// "A", "A and B", "A and 2 more" (MATH-146).
    static func fewNames(_ names: [String]) -> String { names.count < 3 ? names.joined(separator: " and ") : "\(names[0]) and \(names.count - 1) more" }

    /// The line at the foot of onboarding's chat and progress (MATH-146: names what is coming in, counts nothing).
    public static func footLine(_ session: JSONValue?) -> String {
        guard let session else { return "" }
        let jobs = workJobs(J.arr(session["jobs"]))
        let importing = runningFirst(jobs).filter { J.str($0["kind"]) == "import" && !statusOf($0).done }.map(importName)
        let lead = !importing.isEmpty ? "Bringing in \(fewNames(importing))" : jobs.contains { !statusOf($0).done } ? "Looking through your apps" : !jobs.isEmpty ? "Everything's in" : ""
        let needs = J.arr(session["needs"]).filter { J.truthy($0) && !J.truthy($0["closed"]) }
        var waiting = ""
        if !needs.isEmpty {
            var apps: [String] = []
            for need in needs { let name = J.truthy(need["app"]) ? ConnectSources.shownName(J.str(need["app"])) : ""; if !apps.contains(name) { apps.append(name) } }
            if apps.allSatisfy({ !$0.isEmpty }) { waiting = "\(fewNames(apps)) need\(apps.count == 1 ? "s" : "") you" }
            else { waiting = needs.count == 1 ? "1 step needs you" : "\(needs.count) steps need you" }
        }
        return [lead, waiting].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// What the chat says under its last message while the person waits.
    public static func chatStatus(_ session: JSONValue?) -> String {
        guard let session else { return "" }
        if J.truthy(session["thinking"]) { return leadOf(session) }
        if !J.truthy(session["waiting"]) { return "" }
        let going = workJobs(J.arr(session["jobs"])).filter { !statusOf($0).done && !statusOf($0).waiting }
        if let survey = going.first(where: { J.str($0["kind"]) == "survey" }) ?? going.first { return "\(J.str(survey["label"]))…" }
        return J.arr(session["needs"]).isEmpty ? "Looking…" : "Waiting for your sign-in…"
    }

    /// What a step the agents hand the person asks of them, the button that does it, and how.
    public static func needView(_ need: JSONValue?) -> NeedView {
        let kind = J.str(need?["kind"])
        let app = need.map { ConnectSources.shownName(J.str($0["app"])) } ?? ""
        if kind == "signin-here" {
            let browser = J.str(need?["browser"])
            return NeedView(title: "Sign in to \(app)", action: J.str(need?["where"]) == "browser" ? "Sign in in \(browser.isEmpty ? "your browser" : browser)" : "Sign in inside Engelbart", hint: "")
        }
        if kind == "connector" { return NeedView(title: "\(app) needs you to sign in", action: "Log in", hint: "Opens in your browser · read-only") }
        if kind == "permission" { return NeedView(title: "\(app) needs your permission", action: "Allow", hint: "macOS will ask") }
        let raw = J.str(need?["app"])
        if raw == "Zotero" || raw == "GitHub" { return NeedView(title: "\(app) needs you to sign in", action: "Log in", hint: "Opens in your browser · read-only") }
        let what = ["signin": "sign in", "2fa": "enter a code", "password": "sign in", "captcha": "prove you are not a robot", "confirm": "confirm something"][kind] ?? "sign in"
        let signs = kind == "signin" || kind == "password"
        return NeedView(title: "\(app.isEmpty ? "An app" : app) needs you to \(what)", action: signs ? "Log in" : "Open", hint: signs ? "Opens in your browser · read-only" : "Opens its window to \(what)")
    }

    /// MEMORY.md's line in the progress list.
    public static func memoryLine(_ memory: JSONValue?) -> JobStatus {
        let status = J.str(memory?["status"])
        switch status {
        case "saved":
            let removed = J.int(memory?["removed"])
            return JobStatus(text: removed > 0 ? "Saved · \(removed) secret\(removed == 1 ? "" : "s") masked" : "Saved", done: true)
        case "writing": return JobStatus(text: "Writing…", done: false)
        case "cleaning": return JobStatus(text: "Taking out any secrets…", done: false)
        case "failed": return JobStatus(text: "Not saved", done: true, failed: true)
        case "stopped": return JobStatus(text: "Stopped", done: true)
        case "skipped": return JobStatus(text: "Nothing to write from", done: true)
        default: return JobStatus(text: "Waits for the imports", done: false)
        }
    }

    /// The dock's line for a session in the background: what needs the person first, else how far it is. Never "Your
    /// answer" (2026-10-16, Hudson: "nothing should ever say 'your answer'!!!!").
    public static func dockLine(_ session: JSONValue?) -> DockLine? {
        guard let session else { return nil }
        let needs = J.arr(session["needs"])
        if !needs.isEmpty { return DockLine(tone: "warn", short: "Needs you", text: needs.count == 1 ? needView(needs[0]).title : "\(needs.count) steps need you") }
        if J.truthy(session["thinking"]) || (!J.truthy(session["done"]) && !J.truthy(session["finished"])) {
            return DockLine(tone: "busy", short: "Importing", text: "Importing your library…")
        }
        let jobs = workJobs(J.arr(session["jobs"]))
        let ended = jobs.filter { statusOf($0).done }.count
        let memory = memoryLine(session["memory"])
        if !jobs.isEmpty && ended < jobs.count { return DockLine(tone: "busy", short: "Importing \(ended)/\(jobs.count)", text: "Importing · \(ended) of \(jobs.count) done") }
        if !memory.done { return DockLine(tone: "busy", short: "Memory…", text: "MEMORY.md · \(memory.text.lowercased())") }
        let n = session["counts"].map { J.int($0["notes"]) + J.int($0["items"]) } ?? 0
        let saved = J.str(session["memory"]?["status"]) == "saved"
        return DockLine(tone: "done", short: "Library", text: "Library connected\(n > 0 ? " · \(n) added" : "")\(saved ? " · MEMORY.md saved" : "")")
    }

    /// When a log entry happened, as the activity list shows it: "14:02".
    public static func logTime(_ at: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: at) ?? { iso.formatOptions = [.withInternetDateTime]; return iso.date(from: at) }()
        guard let date else { return "" }
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    /// Connect your library in the sidebar's Inbox: a session of this project (or one with no project yet) that needs the
    /// person, or has finished.
    public static func connectInbox(_ sessions: [JSONValue], projectId: String?) -> [InboxEntry] {
        var out: [InboxEntry] = []
        for session in sessions {
            let pid = session["projectId"]?.string
            if J.truthy(session["dismissed"]) || J.truthy(session["stopped"]) || (pid != nil && !pid!.isEmpty && pid != projectId) { continue }
            guard let view = dockLine(session), view.tone != "busy" else { continue }
            let id = J.str(session["id"])
            out.append(InboxEntry(id: "connect:\(id)", kind: "connect", sessionId: id, workspaceId: nil, name: "Connect your library", did: view.text, at: session["created"]?.string))
        }
        return out
    }
}

/// The sign-ins opened one after another (signInWindows, 2026-10-12): for each web app just ticked that is not signed in,
/// and each one turned down. `pick(rows)` is signInChain on the screen as it is now; `open(row)` starts the row's sign-in
/// and answers once nothing of it is open any more: 'signed-in' | 'rejected' | 'browser' | 'declined' (the row comes back
/// first, once, and its group gets Engelbart's window) | 'replaced' | 'dropped' | 'closed' (only this stops the chain,
/// which forgets the rest). One sign-in at a time: rows sent while one is open wait their turn, those of its group aside.
@MainActor
public final class SignInWindows {
    let pick: ([SourceApp]) -> [SourceApp]
    let open: (SourceApp) async throws -> String
    private var rows: [SourceApp] = []
    private var opened = ""
    public init(pick: @escaping ([SourceApp]) -> [SourceApp], open: @escaping (SourceApp) async throws -> String) { self.pick = pick; self.open = open }

    public func turnedDown(_ more: [SourceApp] = []) async {
        rows += more.filter { !(!opened.isEmpty && ConnectSources.sharesSignIn(opened).contains($0.app)) }
        if !opened.isEmpty { return }
        var again = Set<String>()
        while let row = pick(rows).first {
            rows = rows.filter { !ConnectSources.sharesSignIn(row.app).contains($0.app) }
            opened = row.app
            var out = "closed"
            do { out = try await open(row) } catch { out = "closed" }
            opened = ""
            if out == "closed" { break }
            let group = ConnectSources.signInGroup(row.app)
            if out == "declined" && !again.contains(group) { again.insert(group); rows = [row] + rows }
        }
        rows = []
    }
}
