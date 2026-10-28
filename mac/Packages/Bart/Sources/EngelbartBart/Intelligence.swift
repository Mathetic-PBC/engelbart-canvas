import Foundation

// renderer/model/intelligence.js — Settings › Intelligence (2026-10-06, MATH-53): what its rows show and what a pick in
// them saves. Pure: ModelSettings.read's result in, rows and patches out. The provider a row runs on is found as a run
// finds it (InForce). The panel itself is drawn by the Settings screen (wave 2); this is its logic.

public enum Intelligence {
    public struct Row: Equatable, Sendable { public var id: String, name: String, place: String?, label: String?, also: String? }

    /// One row per agent. `place`: where its last pick by hand is kept; Build's covers a post-it's quick task too (`also`).
    /// @chat (the agent the app calls 'bart') and @create, which runs on its models, share a row.
    public static let agentRows: [Row] = [
        Row(id: "bart", name: "@chat", place: "bart", label: "@chat and @create", also: nil),
        Row(id: "brainstorm", name: "@brainstorm", place: nil, label: nil, also: nil),
        Row(id: "discover", name: "@discover", place: nil, label: nil, also: nil),
        Row(id: "build", name: "Build", place: "build", label: nil, also: "quick"),
    ]
    /// @discover's levels under Advanced; `standard` is the row itself.
    public static let advancedLevels: [(id: String, name: String)] = [("quick", "Quick"), ("deep", "Deep")]

    /// The providers shown, in the file's order: the ones config.json offers.
    public static func shownProviders(_ s: SettingsModels) -> [String] { s.models.providers.keys.filter { s.offered.contains($0) } }

    static func inForce(_ s: SettingsModels, _ place: String? = nil) -> ModelsList {
        let offered = InForce.onlyProviders(s.models, s.offered)
        return InForce.preferUsable(place.map { InForce.startingAt(offered, $0, s.choices[$0]) } ?? offered, s.usable)
    }

    /// The saved default provider of @bart ('bart') or of Build ('build').
    public static func savedProvider(_ s: SettingsModels, _ which: String) -> String { which == "build" ? s.models.build!.provider : s.models.provider }

    /// The default provider as a run sees it.
    public static func defaultProvider(_ s: SettingsModels, _ which: String) -> String {
        let m = inForce(s)
        return which == "build" ? m.build!.provider : m.provider
    }

    /// `agent`'s default on `provider`; `level` is @discover's.
    public static func defaultStep(_ m: ModelsList, _ agent: String, _ provider: String, level: String = "standard") -> Rung? {
        switch agent {
        case "bart": return m.providers[provider]?.ladder.first
        case "brainstorm": return m.brainstorm?.providers[provider]
        case "discover": return m.discover?.providers[provider]?[level]
        default: return m.build?.providers[provider]?.default
        }
    }

    /// What a cell's model grid lists: that provider alone, with @bart's models and efforts (Build's for Build).
    public static func cellModels(_ m: ModelsList, _ agent: String, _ provider: String) -> ModelsList {
        let entry = m.providers[provider]!
        var list = entry
        list.start = nil
        if agent == "build", let b = m.build?.providers[provider] { list = ProviderEntry(name: entry.name, models: b.models, efforts: b.efforts, ladder: [b.default]) }
        return ModelsList(about: "", provider: provider, providers: Ordered([(provider, list)]))
    }

    /// post-its/ModelGrid.jsx effortFor: the effort a press on a model gives it (the one picked for it, else its ladder
    /// step's, else the ladder's first effort, else the first effort).
    public static func effortFor(_ m: ModelsList, _ key: String, efforts: [String: String] = [:]) -> String {
        let entry = m.providers.pairs.first { $0.1.models[key] != nil }?.1 ?? m.providers[m.provider]!
        if let e = efforts[key], entry.efforts.contains(e) { return e }
        if let step = entry.ladder.first(where: { $0.model == key }) { return step.effort }
        return entry.efforts.contains(entry.ladder[0].effort) ? entry.ladder[0].effort : entry.efforts[0]
    }

    /// What a pick in a cell saves (ModelSettings.save).
    public static func patchOf(_ agent: String, _ provider: String, _ pick: Rung, level: String = "standard") -> OJ {
        let step: OJ = ["model": .string(pick.model), "effort": .string(pick.effort)]
        if agent == "discover" { return ["discover": .object([(provider, .object([(level, step)]))])] }
        return .object([(agent, .object([(provider, step)]))])
    }

    /// "Opus Extra high": a step as a chip reads.
    public static func stepLabel(_ models: Ordered<ModelInfo>?, _ step: Rung?) -> String {
        guard let models, let step, let model = models[step.model] else { return "" }
        return "\(model.name) \(Question.effortLabels[step.effort] ?? step.effort)"
    }

    public struct Pick: Equatable, Sendable { public var provider, model, effort, label: String }

    /// The pick by hand `place` starts on instead of its default, or nil.
    public static func lastPick(_ s: SettingsModels, _ place: String) -> Pick? {
        guard let held = s.choices[place], s.offered.contains(held.provider) else { return nil }
        let agent = place == "bart" ? "bart" : "build"
        let m = s.models
        let models = agent == "bart" ? m.providers[held.provider]?.models : m.build?.providers[held.provider]?.models
        let efforts = agent == "bart" ? m.providers[held.provider]?.efforts : m.build?.providers[held.provider]?.efforts
        guard let models, let efforts, models[held.model] != nil, efforts.contains(held.effort) else { return nil }
        let run = inForce(s, place)
        if (agent == "bart" ? run.provider : run.build!.provider) != held.provider { return nil }
        let provider = defaultProvider(s, agent)
        if let step = defaultStep(m, agent, provider), held.provider == provider && held.model == step.model && held.effort == step.effort { return nil }
        return Pick(provider: held.provider, model: held.model, effort: held.effort, label: stepLabel(models, Rung(model: held.model, effort: held.effort)))
    }

    /// The provider @brainstorm and @discover run on instead of @bart's default one, or nil.
    public static func followedPick(_ s: SettingsModels) -> (provider: String, label: String)? {
        let home = defaultProvider(s, "bart"), provider = inForce(s, "bart").provider
        return provider == home ? nil : (provider, s.models.providers[provider]!.name)
    }
}
