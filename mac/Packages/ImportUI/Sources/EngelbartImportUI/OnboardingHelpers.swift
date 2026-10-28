import Foundation
import EngelbartCore

// The pieces of src/renderer/model/onboarding.js (the onboarding beta, 2026-10-16, docs/onboarding-beta-10-16.md S3,
// S9–S12) and src/renderer/model/tools.js (rowOf) that Import your context, the agent popup and Connect your library call.
// Screens owns model/onboarding.js and Tools owns model/tools.js; these are local copies over the JSON snapshots main
// sends (the tool check's `engelbart:tools`, providers.cjs's status, browsers.cjs's list), so this package depends on
// neither (listed under "Needs" in API.md).

public enum KeychainStep: Equatable, Sendable {
    /// The browsers are still being looked for: "Looking for your browsers…" in place, then asked (S11).
    case wait
    /// Answered before ('allowed' | 'declined'), or no browser to ask about ('declined').
    case go(String)
    /// Safari chosen without Full Disk Access (S9).
    case safari
    /// "Allow Engelbart to use your {browser} sign-ins".
    case ask
}

public enum OnboardingHelpers {
    /// The browser's sign-ins, asked once before the work questions (S9–S12) → what comes next, from api.browsers().
    public static func keychainStep(_ browsers: JSONValue?) -> KeychainStep {
        guard let browsers, J.truthy(browsers) else { return .wait }
        let keychain = J.str(browsers["keychain"])
        if keychain == "allowed" { return .go("allowed") }
        if keychain == "declined" || keychain == "refused" { return .go("declined") }
        if J.arr(browsers["browsers"]).isEmpty { return .go("declined") }
        if J.str(browsers["chosenId"]) == "safari" && !J.isTrue(browsers["safari"]?["diskAccess"]) { return .safari }
        return .ask
    }

    /// The chosen browser's profiles ([] for one with a single profile, or none readable).
    public static func profilesOf(_ browsers: JSONValue?) -> [JSONValue] {
        let chosen = J.arr(browsers?["browsers"]).first { J.str($0["id"]) == J.str(browsers?["chosenId"]) }
        return chosen?["profiles"]?.array ?? []
    }

    /// After Allow (or Safari's disk access granted): "profile" when the chosen browser has more than one and none of them
    /// was chosen (S10), else "macos": the one prompt macOS shows for the browser's sign-ins, at once (S12).
    public static func afterAllow(_ browsers: JSONValue?) -> String {
        let profiles = profilesOf(browsers)
        let chosen = J.str(browsers?["chosenProfile"])
        if profiles.count > 1 && !profiles.contains(where: { J.str($0["id"]) == chosen && !chosen.isEmpty }) { return "profile" }
        return "macos"
    }

    /// The run's `keychain` (S11): from the answer alone.
    public static func runKeychain(_ browsers: JSONValue?) -> Bool { J.str(browsers?["keychain"]) == "allowed" }

    // Claude Code and Codex, as the agent popup names them (S3).
    public static let clis = ["claude", "codex"]
    static let providerOfCliMap = ["claude": "anthropic", "codex": "openai"]
    public static func providerOfCli(_ id: String?) -> String? { id.flatMap { providerOfCliMap[$0] } }
    public static func cliOfProvider(_ provider: String?) -> String? { provider == "openai" ? "codex" : provider == "anthropic" ? "claude" : nil }
    /// "Connect to Claude", "Connect to ChatGPT", "Connect to Claude and ChatGPT": the account each CLI signs in with.
    public static let connectTo = ["claude": "Claude", "codex": "ChatGPT"]
    public static func connectLabel(_ ids: [String]) -> String {
        let names = clis.filter { ids.contains($0) }.compactMap { connectTo[$0] }
        return names.isEmpty ? "" : "Connect to \(names.joined(separator: " and "))"
    }
    /// What a choice in the popup covers: 'claude' | 'codex' | 'both'.
    public static func choiceIds(_ choice: String?) -> [String] { choice == "both" ? clis : clis.contains(choice ?? "") ? [choice!] : [] }

    static func providerEntry(_ providers: JSONValue?, _ id: String) -> JSONValue? {
        J.arr(providers?["providers"]).first { J.str($0["id"]) == providerOfCliMap[id] }
    }
    static func toolOf(_ snapshot: JSONValue?, _ id: String) -> JSONValue? {
        guard let tool = snapshot?["tools"]?[id], J.truthy(tool) else { return nil }
        return tool
    }
    static let outdated = ["outdated", "incompatible"]

    /// Whether a CLI is installed and signed in with a subscription, by its own word, whatever its version.
    public static func subscribedCli(_ snapshot: JSONValue?, _ providers: JSONValue?, _ id: String) -> Bool {
        guard let tool = toolOf(snapshot, id), J.truthy(tool["installed"]), let one = providerEntry(providers, id),
              !["missing", "failed"].contains(J.str(tool["status"])) else { return false }
        if let subscribed = one["subscribed"]?.bool { return subscribed }
        return J.truthy(one["signedIn"]) && J.truthy(one["subscription"])
    }

    /// Where one CLI stands for the agent popup.
    public static func cliStage(_ snapshot: JSONValue?, _ providers: JSONValue?, _ id: String, refused: Bool = false) -> String {
        guard let tool = toolOf(snapshot, id) else { return "connecting" }
        let busy = tool["busy"].flatMap(J.present)
        let status = J.str(tool["status"])
        if let busy, J.str(busy["action"]) == "sign-in" { return "signing-in" }
        if let busy, J.str(busy["action"]) != "sign-out" { return "connecting" }
        if ["installing", "checking", "unknown", "updating"].contains(status) { return "connecting" }
        if status == "failed" { return "failed" }
        if !J.truthy(tool["installed"]) || status == "missing" { return J.truthy(tool["error"]) ? "failed" : "install" }
        if outdated.contains(status) { return J.truthy(tool["autoUpdate"]) ? "connecting" : "update" }
        if !refused && status == "ready" && subscribedCli(snapshot, providers, id) { return "ready" }
        return "sign-in"
    }

    public struct AgentPrimary: Equatable, Sendable {
        public var label: String
        public var action: String?
        public var ids: [String]
        public var url: String?
        public var disabled: Bool
    }

    public struct AgentChoice: Equatable, Sendable {
        public var stages: [String: String]
        public var install: [String], update: [String], signIn: [String], failed: [String]
        public var done: Bool
        public var primary: AgentPrimary
        public var problem: String
    }

    /// The agent popup for a choice (S3: "Claude Code, Codex, or both").
    public static func agentChoice(_ snapshot: JSONValue?, _ providers: JSONValue?, _ choice: String?, refused: String? = nil) -> AgentChoice {
        let ids = choiceIds(choice)
        var stages: [String: String] = [:]
        for id in ids { stages[id] = cliStage(snapshot, providers, id, refused: refused == id) }
        func having(_ stage: String) -> [String] { ids.filter { stages[$0] == stage } }
        let install = having("install"), update = having("update"), signIn = having("sign-in"), failed = having("failed"), signing = having("signing-in")
        let done = !having("ready").isEmpty
        func errorOf(_ list: [String]) -> String {
            for id in list { if let error = toolOf(snapshot, id)?["error"]?.string, !error.isEmpty { return firstSentence(error, max: 160) } }
            return ""
        }
        let primary: AgentPrimary
        if ids.isEmpty { primary = AgentPrimary(label: "Continue", action: nil, ids: [], url: nil, disabled: true) }
        else if done { primary = AgentPrimary(label: "Connected", action: nil, ids: [], url: nil, disabled: true) }
        else if !signIn.isEmpty { primary = AgentPrimary(label: connectLabel(signIn), action: "sign-in", ids: signIn, url: nil, disabled: false) }
        else if !signing.isEmpty {
            let url = J.str(toolOf(snapshot, signing[0])?["busy"]?["url"])
            primary = url.isEmpty ? AgentPrimary(label: "Finish signing in…", action: nil, ids: [], url: nil, disabled: true)
                : AgentPrimary(label: "Open sign-in page", action: "open", ids: [signing[0]], url: url, disabled: false)
        } else if !failed.isEmpty && failed.count == ids.count - having("ready").count {
            primary = AgentPrimary(label: "Try again", action: "retry", ids: failed, url: nil, disabled: false)
        } else { primary = AgentPrimary(label: "Connecting…", action: nil, ids: [], url: nil, disabled: true) }
        return AgentChoice(stages: stages, install: install, update: update, signIn: signIn, failed: failed, done: done, primary: primary, problem: failed.isEmpty ? "" : errorOf(failed))
    }

    /// The provider a single choice names (remembered, so Import your context does not ask again), or nil for both.
    public static func providerOfChoice(_ choice: String?) -> String? { choice == "claude" || choice == "codex" ? providerOfCli(choice) : nil }

    // MARK: model/tools.js rowOf

    public struct ToolRowView: Equatable, Sendable {
        public var id: String, name: String, state: String, tone: String, action: String?, detail: String?, page: String?
    }
    static let agents = ["claude", "codex"]

    /// A tool's row (model/tools.js rowOf): its state's words, tone and the one action it offers.
    public static func rowOf(_ tool: JSONValue) -> ToolRowView {
        let id = J.str(tool["id"]), name = J.str(tool["name"])
        var row = ToolRowView(id: id, name: name, state: "", tone: "muted", action: nil, detail: nil, page: nil)
        let busy = tool["busy"].flatMap(J.present)
        let agent = agents.contains(id)
        let error = tool["error"]?.string
        if let busy {
            switch J.str(busy["action"]) {
            case "install": let phase = J.str(busy["phase"]); row.state = agent ? "Connecting…" : (phase.isEmpty ? "Installing…" : phase); row.tone = "busy"; return row
            case "update": row.state = "Updating…"; row.tone = "busy"; return row
            case "sign-in": row.state = "Finish signing in in your browser"; row.tone = "busy"; row.action = "cancel"; row.page = busy["url"]?.string; return row
            case "sign-out": row.state = "Signing out…"; row.tone = "busy"; return row
            default: break
            }
        }
        let version = J.str(tool["version"])
        switch J.str(tool["status"]) {
        case "ready":
            row.state = version.isEmpty ? "Installed" : "\(version)\(J.truthy(tool["untested"]) ? " · untested" : "")\(J.str(tool["source"]) == "bundled" ? " · built in" : "")"
            row.tone = "ok"; row.detail = version.isEmpty ? error : tool["note"]?.string
        case "signed-out": row.state = "Not signed in"; row.tone = "warn"; row.action = "sign-in"; row.detail = error
        case "missing": row.state = J.truthy(tool["skip"]) ? "Skipped" : "Not installed"; row.action = "install"; row.detail = error
        case "outdated", "incompatible":
            let why = J.str(tool["status"]) == "outdated" ? "needs \(J.str(tool["minimum"]))" : "does not work with Engelbart"
            let canUpdate = id != "git" || J.str(tool["source"]) == "homebrew"
            row.state = "\(version) · \(why)"; row.tone = "warn"; row.action = canUpdate ? "update" : nil; row.detail = error
        case "failed": row.state = "Not working"; row.tone = "error"; row.action = "retry"; row.detail = error
        default: row.state = agent ? "Connecting…" : "Checking…"; row.tone = "busy"
        }
        return row
    }
}
