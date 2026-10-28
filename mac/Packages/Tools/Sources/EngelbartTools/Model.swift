import Foundation

// What the setup dialog shows for Git, Claude Code and Codex (src/renderer/model/tools.js, 2026-09-23; design D15). Pure:
// the manager's snapshot in, rows out.

public let TOOL_ORDER = ["git", "claude", "codex"]

/// The tools the dialog opens with after the launch check, or [] for no dialog: Git missing (or unable to run); neither
/// agent installed; no agent able to run a question; an agent installed but not signed in (2026-09-29: often one
/// Engelbart installed in the background, which then still needs its sign-in); an update waiting for the person. A
/// skipped tool is not asked about again until Ask again.
public func launchRows(_ snapshot: ToolsSnapshot?) -> [String] {
    guard let snapshot, snapshot.checked, let git = snapshot["git"] else { return [] }
    let tools = snapshot.tools
    var rows: [String] = []
    if (git.status == "missing" || git.status == "failed") && !git.skip { rows.append("git") }
    let installed = AGENTS.filter { tools[$0]?.installed == true }
    if installed.isEmpty {
        if !AGENTS.allSatisfy({ tools[$0]?.skip == true }) { rows += AGENTS }
    } else if !AGENTS.contains(where: { tools[$0]?.status == "ready" }) {
        rows += installed.filter { tools[$0]?.skip != true }
    }
    for name in AGENTS {
        guard let tool = tools[name] else { continue }
        if rows.contains(name) || tool.skip || tool.busy != nil { continue }
        if tool.status == "signed-out" || ((tool.status == "outdated" || tool.status == "incompatible") && !tool.autoUpdate) { rows.append(name) }
    }
    return TOOL_ORDER.filter { rows.contains($0) }
}

/// The agents an install has just brought in without a sign-in: installing in `before`, done and signed out in `after`,
/// not skipped. The dialog asks them to sign in once the install is over, whenever it ends.
public func installedSignedOut(_ before: ToolsSnapshot?, _ after: ToolsSnapshot?) -> [String] {
    guard let before, let after else { return [] }
    return AGENTS.filter { name in
        guard let was = before[name], let now = after[name] else { return false }
        return was.busy?.action == "install" && now.busy == nil && now.status == "signed-out" && !now.skip
    }
}

/// A tool needs the person when it is not installed, cannot run, or waits on them (the rows Skip applies to).
public func needsAction(_ tool: ToolSnapshot?) -> Bool {
    guard let tool else { return false }
    return tool.busy == nil && tool.status != "ready"
}

/// One row of the dialog.
public struct ToolRow: Equatable, Sendable {
    public var id: String
    public var name: String
    /// What it says.
    public var state: String
    /// ok | muted | busy | warn | error
    public var tone: String
    /// install | update | sign-in | retry | cancel, or nil: the one button.
    public var action: String?
    /// A line under it.
    public var detail: String?
    /// error (red) or warn (amber: the record's `note`, such as an older copy first on PATH).
    public var detailTone: String
    /// An address to open again while signing in.
    public var page: String?
    public var skipped: Bool
    /// Who Claude Code or Codex is signed in as (Connections' "Connected · <account>").
    public var account: String?
}

public let ACTION_LABEL = ["install": "Install", "update": "Update", "sign-in": "Sign in", "retry": "Try again", "cancel": "Cancel"]

public func rowOf(_ tool: ToolSnapshot) -> ToolRow {
    let account = tool.signedIn == true && !(tool.account ?? "").isEmpty ? tool.account : nil
    var row = ToolRow(id: tool.id, name: tool.name, state: "", tone: "muted", action: nil, detail: nil, detailTone: "error", page: nil, skipped: tool.skip, account: account)
    // Claude Code and Codex are "connected", not installed (2026-10-14, a beta tester: "it says installing claude code, even
    // if it is already installed. it should say connecting instead"): to the person, an install Engelbart runs in the
    // background, or a check not answered yet, is connecting what they have. Git keeps Apple's installer's own steps.
    let agent = isAgent(tool.id)
    if let busy = tool.busy {
        switch busy.action {
        case "install": row.state = agent ? "Connecting…" : (busy.phase ?? "Installing…"); row.tone = "busy"; return row
        case "update": row.state = "Updating…"; row.tone = "busy"; return row
        case "sign-in": row.state = "Finish signing in in your browser"; row.tone = "busy"; row.action = "cancel"; row.page = busy.url; return row
        case "sign-out": row.state = "Signing out…"; row.tone = "busy"; return row // Connections' Sign out
        default: break
        }
    }
    let version = tool.version ?? ""
    switch tool.status {
    case "ready": // `bundled`: the Git that came with Engelbart, standing in for a Mac without one
        row.state = version.isEmpty ? "Installed" : "\(version)\(tool.untested ? " · untested" : "")\(tool.source == "bundled" ? " · built in" : "")"
        row.tone = "ok"
        row.detail = version.isEmpty ? tool.error : tool.note
        row.detailTone = version.isEmpty ? "error" : "warn"
    case "signed-out":
        row.state = "Not signed in"; row.tone = "warn"; row.action = "sign-in"; row.detail = tool.error
    case "missing":
        row.state = tool.skip ? "Skipped" : "Not installed"; row.action = "install"; row.detail = tool.error
    case "outdated", "incompatible":
        let why = tool.status == "outdated" ? "needs \(tool.minimum)" : "does not work with Engelbart"
        let canUpdate = tool.id != "git" || tool.source == "homebrew"
        row.state = "\(version) · \(why)"; row.tone = "warn"; row.action = canUpdate ? "update" : nil; row.detail = tool.error
    case "failed":
        row.state = "Not working"; row.tone = "error"; row.action = "retry"; row.detail = tool.error
    default:
        row.state = agent ? "Connecting…" : "Checking…"; row.tone = "busy"
    }
    return row
}

/// Which of the rows shown Install all would install: those not installed.
public func installable(_ snapshot: ToolsSnapshot, _ ids: [String]) -> [String] {
    ids.filter { snapshot[$0]?.status == "missing" && snapshot[$0]?.busy == nil }
}

/// What Skip warns about for these tools, one line each (Hudson: "a warning that Engelbart will be restricted").
public func skipWarnings(_ snapshot: ToolsSnapshot, _ ids: [String]) -> [String] {
    var lines: [String] = []
    if ids.contains("git") && snapshot["git"]?.status != "ready" { lines.append("Without Git, Engelbart can’t build or keep your code’s history.") }
    // Skipping an agent only restricts anything when no agent can run a question.
    if AGENTS.contains(where: { ids.contains($0) }) && !AGENTS.contains(where: { snapshot[$0]?.status == "ready" }) {
        lines.append("Without Claude Code or Codex, @bart and summaries can’t run.")
    }
    return lines
}

/// Every row shown is ready (installed, recent enough, signed in): the dialog can close.
public func allDone(_ snapshot: ToolsSnapshot, _ ids: [String]) -> Bool {
    !ids.isEmpty && ids.allSatisfy { snapshot[$0] != nil && snapshot[$0]?.busy == nil && snapshot[$0]?.status == "ready" }
}

/// When the setup dialog opens (src/renderer/App.jsx, the effects around `launchAsk`). The launch check's first answer
/// opens it once, and only when something needs the person; Engelbart ▸ Set Up Tools… opens it with all three at any time.
/// An agent installed while the app is open (Claude Code, in the background, on a Mac that had neither) asks for its
/// sign-in once the install is over, whatever was answered before. A new install's onboarding asks on a screen of its own
/// (2026-09-28), so the dialog waits until it is over: its Install all leaves `after` (once the installs end, the dialog
/// asks only what is left: signing in, a failure); its Skip for now asks nothing more until the next launch.
@MainActor
public final class SetupGate: ObservableObject {
    public enum Mode: String, Sendable { case launch, all }
    public struct Request: Equatable, Sendable { public var mode: Mode; public var ids: [String] }
    enum Ask: Equatable { case rows([String]), after }

    /// The dialog to show now, or nil. The app shows it while no other popup is up (App.jsx `setupUp`).
    @Published public private(set) var request: Request?
    @Published public private(set) var tools: ToolsSnapshot?
    /// Onboarding a new install is on screen: the dialog is held back.
    public var onboardingNew = false { didSet { settle() } }

    var launchAsk: Ask?
    var askedAtLaunch = false

    public init() {}

    /// Every snapshot (`engelbart:tools`), and the answer to `tools`.
    public func take(_ snapshot: ToolsSnapshot) {
        let before = tools
        tools = snapshot
        if askedAtLaunch && !installedSignedOut(before, snapshot).isEmpty && launchAsk == nil { launchAsk = .after }
        if !askedAtLaunch && snapshot.checked {
            askedAtLaunch = true
            let ids = launchRows(snapshot)
            if !ids.isEmpty { launchAsk = .rows(ids) }
        }
        settle()
    }

    /// Engelbart ▸ Set Up Tools… (`engelbart:tools-open`).
    public func openAll() { request = Request(mode: .all, ids: TOOL_ORDER) }

    /// Onboarding's tools screen was answered: "install" → ask what is left once the installs end; "skip" → nothing.
    public func onboardingTools(_ choice: String) {
        askedAtLaunch = true
        launchAsk = choice == "install" ? .after : nil
        settle()
    }

    /// The dialog was closed (Done, ×, Escape, Skip).
    public func close() { request = nil }

    func settle() {
        guard let ask = launchAsk, !onboardingNew, let tools else { return }
        switch ask {
        case .after:
            if TOOL_ORDER.contains(where: { tools[$0]?.busy != nil }) { return }
            let ids = launchRows(tools)
            if !ids.isEmpty && request == nil { request = Request(mode: .launch, ids: ids) }
        case .rows(let ids):
            if request == nil { request = Request(mode: .launch, ids: ids) }
        }
        launchAsk = nil
    }
}
