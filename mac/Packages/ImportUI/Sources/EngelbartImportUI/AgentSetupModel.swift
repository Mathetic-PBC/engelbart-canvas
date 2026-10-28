import Foundation
import Combine
import EngelbartCore

// The agent popup (2026-10-16, the onboarding beta's S3; src/renderer/import/AgentSetup.jsx): "Use Claude Code, Codex, or
// both?". Choosing installs what is missing and updates what is out of date, at once and once each; one installed and up
// to date but not signed in waits for one press, "Connect to Claude" (or ChatGPT, or both). Once one can run, the flow
// goes on by itself (`onDone`). No line under the title or the rows, no versions, Skip in plain text on the far left.
// It is Welcome's popup (Screens hosts it) and Import your context's 'tools-setup' dialog.

@MainActor
public final class AgentSetupModel: ObservableObject {
    @Published public private(set) var choice: String?
    @Published public private(set) var error = ""
    @Published public private(set) var tools: JSONValue?
    @Published public private(set) var providers: JSONValue?
    public let refused: String?
    let api: ImportAPI
    let watchDone: Bool
    public var onDone: (String?) -> Void
    public var onSkip: () -> Void
    private var started = Set<String>()
    private var fired = false

    /// `initial` the choice to start on ('claude' | 'codex' | 'both' | nil: a provider the flow asked for), `refused` the CLI
    /// that turned the agents away while signed in; `watchDone`: the popup goes on by itself once one runs.
    public init(api: ImportAPI, tools: JSONValue?, providers: JSONValue?, initial: String? = nil, refused: String? = nil, watchDone: Bool = true,
                onDone: @escaping (String?) -> Void = { _ in }, onSkip: @escaping () -> Void = {}) {
        self.api = api; self.tools = tools; self.providers = providers; self.choice = initial; self.refused = refused; self.watchDone = watchDone
        self.onDone = onDone; self.onSkip = onSkip
        run()
    }

    public var plan: OnboardingHelpers.AgentChoice { OnboardingHelpers.agentChoice(tools, providers, choice, refused: refused) }
    public var line: String { error.isEmpty ? plan.problem : error }
    /// A row's ✓: that CLI runs (never on Both).
    public func readyRow(_ id: String) -> Bool { id != "both" && plan.stages[id] == "ready" }

    public func choose(_ id: String) { error = ""; choice = id; run() }

    /// The host's newest tool check and providers.
    public func update(tools: JSONValue?, providers: JSONValue?) { self.tools = tools; self.providers = providers; run() }

    // What a choice starts, started once per tool (a failure's Try again starts it again); one running: on by itself.
    private func run() {
        let plan = self.plan
        for id in plan.install where !started.contains("install:\(id)") {
            started.insert("install:\(id)")
            Task { do { try await api.toolsInstall([id]) } catch { self.error = tidyError(error) } }
        }
        for id in plan.update where !started.contains("update:\(id)") {
            started.insert("update:\(id)")
            Task { do { try await api.toolsUpdate(id) } catch { self.error = tidyError(error) } }
        }
        if watchDone && plan.done && !fired { fired = true; onDone(choice) }
    }

    public func primary() {
        error = ""
        let p = plan.primary
        if p.action == "open", let url = p.url { Task { do { try await api.openExternal(url) } catch { self.error = tidyError(error) } }; return }
        if p.action == "sign-in" { for id in p.ids { Task { do { try await api.toolsSignIn(id) } catch { self.error = tidyError(error) } } }; return }
        if p.action == "retry" {
            for id in p.ids { started.remove("install:\(id)"); started.remove("update:\(id)") }
            Task { do { try await api.toolsInstall(p.ids) } catch { self.error = tidyError(error) } }
        }
    }

    public static let choices: [(id: String, name: String, logos: [String])] = [("claude", "Claude Code", ["anthropic"]), ("codex", "Codex", ["openai"]), ("both", "Both", ["anthropic", "openai"])]
}
