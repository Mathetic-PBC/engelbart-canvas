import Foundation
import EngelbartDoc
import EngelbartCore

// models.cjs — which model answers an @bart question, and at what effort (2026-09-19). One file for every project,
// <home>/model-effort-inline-question.json, written with the defaults when it is missing and read again for every
// question, so an edit needs no restart. A default changed in a later build reaches the file too, unless the person
// changed that value (CarryDefaults). A question starts on the first step of the default provider's ladder, or where
// the last question picked by hand did (InForce.startingAt, Choices). `@bart --opus --high …` picks by hand and turns
// that off. Flags are matched loosely (Question).

public enum Models {
    static let modelIdRE = JSRegex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
    static let keyRE = JSRegex("^[a-z][a-z0-9]{0,23}$")
    /// Which CLI each provider runs on (tools/requirements.cjs TOOL_OF).
    public static let toolOf = ["anthropic": "claude", "openai": "codex"]

    /// A provider's `models` as the file holds them, bad entries dropped; the defaults when none is left.
    static func cleanModels(_ given: OJ?, _ fallback: Ordered<ModelInfo>) -> Ordered<ModelInfo> {
        var models = Ordered<ModelInfo>()
        for (name, model) in given?.pairs ?? [] {
            let k = name.lowercased()
            guard keyRE.test(k), model.isObject, let id = model["id"]?.string, modelIdRE.test(id) else { continue }
            let named = model["name"]?.string.map { $0.jsTrim } ?? ""
            models[k] = ModelInfo(id: id, name: named.isEmpty ? k.prefix(1).uppercased() + k.dropFirst() : named.jsSlice(0, 40),
                                  use: model["use"]?.string.map { $0.jsSlice(0, 300) } ?? "")
        }
        return models.isEmpty ? fallback : models
    }

    static func cleanEfforts(_ given: OJ?, _ fallback: [String]) -> [String] {
        var out: [String] = []
        for e in (given?.array ?? []).compactMap({ effortWord($0) }) where !out.contains(e) { out.append(e) }
        return out.isEmpty ? fallback : out
    }

    /// `effortOf(value)` for any JSON value (JS's String() of a non-string).
    static func effortWord(_ v: OJ?) -> String? {
        guard let v else { return nil }
        switch v {
        case .string(let s): return Question.effortOf(s)
        case .number(let n): return Question.effortOf(jsNumber(n))
        case .bool(let b): return Question.effortOf(b ? "true" : "false")
        default: return nil
        }
    }

    static func modelsOf(_ v: OJ) -> Ordered<ModelInfo> {
        Ordered((v.pairs ?? []).map { ($0.0, ModelInfo(id: $0.1["id"]?.string ?? "", name: $0.1["name"]?.string ?? "", use: $0.1["use"]?.string ?? "")) })
    }

    static func rungOf(_ v: OJ?) -> Rung? {
        guard let v, v.isObject else { return nil }
        return Rung(model: (v["model"]?.string ?? "").lowercased(), effort: effortWord(v["effort"]) ?? "")
    }

    /// The rung as the file wrote it, read loosely: { model: String(model || '').toLowerCase(), effort: effortOf(effort) }.
    static func wanted(_ v: OJ?) -> Rung? {
        guard let v, v.isObject else { return nil }
        let model: String
        switch v["model"] { case .string(let s)?: model = s; case .number(let n)?: model = n == 0 ? "" : jsNumber(n); case .bool(true)?: model = "true"; default: model = "" }
        guard let effort = effortWord(v["effort"]) else { return Rung(model: model.lowercased(), effort: "\u{0}") }
        return Rung(model: model.lowercased(), effort: effort)
    }

    static let defaultBuildProviders: Ordered<BuildEntry> = Ordered(ModelDefaults.build["providers"]!.pairs!.map { (k, v) in
        (k, BuildEntry(models: modelsOf(v["models"]!), efforts: v["efforts"]!.array!.compactMap { $0.string }, default: rungOf(v["default"])!))
    })

    static let defaultProviders: Ordered<ProviderEntry> = Ordered(ModelDefaults.bart["providers"]!.pairs!.map { (k, v) in
        (k, ProviderEntry(name: v["name"]!.string!, models: modelsOf(v["models"]!), efforts: v["efforts"]!.array!.compactMap { $0.string },
                          ladder: v["ladder"]!.array!.compactMap { rungOf($0) }))
    })

    static func defaultRung(_ block: OJ, _ provider: String, _ mode: String? = nil) -> Rung? {
        let p = block["providers"]?[provider]
        return rungOf(mode.map { p?[$0] } ?? p)
    }

    /// Build's block (B3): per provider its models, efforts and the one the dialog starts on.
    public static func normalizeBuild(_ value: OJ?) -> BuildBlock {
        let given = value?.isObject == true ? value! : .object([])
        var providers = Ordered<BuildEntry>()
        for (key, fallback) in defaultBuildProviders {
            let from = given["providers"]?[key].flatMap { $0.isObject ? $0 : nil } ?? .object([])
            let models = cleanModels(from["models"], fallback.models)
            let efforts = cleanEfforts(from["efforts"], fallback.efforts)
            let want = wanted(from["default"])
            func usable(_ r: Rung?) -> Bool { guard let r else { return false }; return models[r.model] != nil && efforts.contains(r.effort) }
            let start = usable(want) ? want! : usable(fallback.default) ? fallback.default
                : Rung(model: models.keys[0], effort: efforts.contains("high") ? "high" : efforts[0])
            providers[key] = BuildEntry(models: models, efforts: efforts, default: start)
        }
        let p = given["provider"]?.string
        return BuildBlock(about: given["about"]?.string ?? ModelDefaults.build["about"]!.string!,
                          provider: p.flatMap { providers[$0] != nil ? $0 : nil } ?? "anthropic", providers: providers)
    }

    /// An @discover provider's levels as the file holds them, { quick, standard, deep }. The one-step shape 2026-09-30
    /// wrote ({ model, effort }) is that provider's `standard` level, the half of it the person left alone taken from that
    /// day's default; quick and deep come from the levels beside it, else the defaults.
    static func discoverLevels(_ from: OJ?, _ key: String) -> OJ {
        guard let from, from.isObject else { return .object([]) }
        if from["model"] == nil && from["effort"] == nil { return from }
        let old = ModelDefaults.discover0930["providers"]?[key] ?? .object([])
        let model = from["model"] ?? old["model"] ?? .null
        let effort = from["effort"] ?? old["effort"] ?? .null
        var out = ModelDefaults.discover["providers"]?[key] ?? .object([])
        for (k, v) in from.pairs! where k != "model" && k != "effort" { out = out.setting(k, v) }
        var standard: [(String, OJ)] = []
        if from["model"] != nil || old["model"] != nil { standard.append(("model", model)) }
        if from["effort"] != nil || old["effort"] != nil { standard.append(("effort", effort)) }
        return out.setting("standard", .object(standard))
    }

    public static func normalizeDiscover(_ value: OJ?, _ providers: Ordered<ProviderEntry>) -> DiscoverBlock {
        let given = value?.isObject == true ? value! : .object([])
        var out = Ordered<[String: Rung]>()
        for (key, entry) in providers {
            let levels = discoverLevels(given["providers"]?[key], key)
            var modes: [String: Rung] = [:]
            for mode in Question.modes {
                let candidates = [wanted(levels[mode]), defaultRung(ModelDefaults.discover, key, mode)]
                modes[mode] = candidates.first(where: { entry.usable($0) }).flatMap { $0 } ?? entry.ladder[0]
            }
            out[key] = modes
        }
        return DiscoverBlock(about: given["about"]?.string ?? ModelDefaults.discover["about"]!.string!, providers: out)
    }

    public static func normalizeBrainstorm(_ value: OJ?, _ providers: Ordered<ProviderEntry>) -> BrainstormBlock {
        let given = value?.isObject == true ? value! : .object([])
        var out = Ordered<Rung>()
        for (key, entry) in providers {
            let candidates = [wanted(given["providers"]?[key]), defaultRung(ModelDefaults.brainstorm, key)]
            out[key] = candidates.first(where: { entry.usable($0) }).flatMap { $0 } ?? entry.ladder[0]
        }
        return BrainstormBlock(about: given["about"]?.string ?? ModelDefaults.brainstorm["about"]!.string!, providers: out)
    }

    /// The file as the app reads it, for CarryDefaults to write: an @discover provider still in the one-step shape as its
    /// three levels (discoverLevels). Nothing else changes.
    public static func fileShape(_ value: OJ) -> OJ {
        guard let discover = value["discover"], discover.isObject, let providers = discover["providers"], providers.isObject else { return value }
        var next = providers
        for key in ModelDefaults.discover["providers"]!.keys {
            if let from = next[key], from.isObject, from["model"] != nil || from["effort"] != nil { next = next.setting(key, discoverLevels(from, key)) }
        }
        return value.setting("discover", discover.setting("providers", next))
    }

    /// Whatever the file holds, made safe to run: unknown providers dropped, bad models, efforts and steps replaced.
    public static func normalize(_ value: OJ?) -> ModelsList {
        let given = value?.isObject == true ? value! : .object([])
        var providers = Ordered<ProviderEntry>()
        for (key, fallback) in defaultProviders {
            let from = given["providers"]?[key].flatMap { $0.isObject ? $0 : nil } ?? .object([])
            let held = cleanModels(from["models"], fallback.models)
            let ladder = (from["ladder"]?.array ?? []).compactMap { step -> Rung? in
                guard step.isObject, let e = effortWord(step["effort"]) else { return nil }
                let r = wanted(step)!
                return held[r.model] != nil ? Rung(model: r.model, effort: e) : nil
            }.prefix(5)
            let fallbackLadder = fallback.ladder.filter { held[$0.model] != nil }
            providers[key] = ProviderEntry(name: fallback.name, models: held, efforts: cleanEfforts(from["efforts"], fallback.efforts),
                                           ladder: !ladder.isEmpty ? Array(ladder) : !fallbackLadder.isEmpty ? fallbackLadder : [Rung(model: held.keys[0], effort: "medium")])
        }
        let p = given["provider"]?.string
        return ModelsList(about: given["about"]?.string ?? ModelDefaults.models["about"]!.string!,
                          provider: p.flatMap { providers[$0] != nil ? $0 : nil } ?? "anthropic", providers: providers,
                          build: normalizeBuild(given["build"]), brainstorm: normalizeBrainstorm(given["brainstorm"], providers),
                          discover: normalizeDiscover(given["discover"], providers))
    }

    /// The text after "@brainstorm" → one step: the models file's `brainstorm` step for the provider an @bart question would
    /// start on, else the default, else that provider's first step. A flag picks nothing here: it is taken off (B-02).
    public static func readBrainstorm(_ text: String?, _ models: ModelsList) -> QuestionRead {
        let provider = models.provider, entry = models.providers[provider]!
        let candidates = [models.brainstorm?.providers[provider], defaultRung(ModelDefaults.brainstorm, provider)]
        let rung = candidates.first(where: { entry.usable($0) }).flatMap { $0 } ?? entry.ladder[0]
        let info = entry.models[rung.model]!
        return QuestionRead(question: Question.readFlags(text, models).rest, provider: provider,
                            steps: [Step(provider: provider, key: rung.model, model: info.id, name: info.name, effort: rung.effort)], pinned: false)
    }

    /// @bart's ladder on `provider` with `first` as its first step (Settings, 2026-10-06): then every step of the built-in
    /// ladder above it that the provider still lists. Made from the built-in ladder each time, so a pick never loses steps.
    public static func withFirstStep(_ provider: String, _ entry: ProviderEntry, _ first: Rung) -> [Rung] {
        let builtIn = defaultProviders[provider]?.ladder ?? []
        return [first] + builtIn.filter { entry.models[$0.model] != nil && entry.efforts.contains($0.effort) && Question.above(entry, $0, first) }
    }

    /// What the Build dialog offers, in the shape the @bart selector draws: per provider its name, Build's models and
    /// efforts, and a one-step `ladder` holding the default.
    public static func buildChoices(_ models: ModelsList) -> (provider: String, providers: Ordered<ProviderEntry>) {
        let build = models.build ?? normalizeBuild(nil)
        var providers = Ordered<ProviderEntry>()
        for key in models.providers.keys {
            guard let entry = build.providers[key] else { continue }
            providers[key] = ProviderEntry(name: models.providers[key]!.name, models: entry.models, efforts: entry.efforts, ladder: [entry.default])
        }
        let provider = [build.provider, models.provider].first { providers[$0] != nil } ?? providers.keys.first ?? build.provider
        return (provider, providers)
    }

    public struct BuildChoice: Equatable, Sendable { public var provider, model, modelId, modelName, effort: String }

    /// A pick from the dialog made real: the defaults when the pick names nothing Build knows.
    public static func resolveBuildChoice(_ models: ModelsList, provider: String?, model: String?, effort: String?) -> BuildChoice {
        let choices = buildChoices(models)
        let at = provider.flatMap { choices.providers[$0] != nil ? $0 : nil } ?? choices.provider
        let entry = choices.providers[at]!
        let key = model.flatMap { entry.models[$0] != nil ? $0 : nil } ?? entry.ladder[0].model
        let level = effort.flatMap { entry.efforts.contains($0) ? $0 : nil } ?? entry.ladder[0].effort
        return BuildChoice(provider: at, model: key, modelId: entry.models[key]!.id, modelName: entry.models[key]!.name, effort: level)
    }

    /// The list in force: the file, with the defaults written the first time and any default changed since carried into
    /// it where the person left that value alone. `only`: the providers config.json offers.
    public static func load(home: URL, only: [String]? = nil) -> ModelsList {
        let file = home.appendingPathComponent(ModelDefaults.modelsFile)
        var held: OJ?
        do {
            held = try CarryDefaults.carry(file: file, defaults: ModelDefaults.models, past: ModelDefaults.past, normalize: fileShape,
                                           backupDir: home.appendingPathComponent(".backups")).value
        } catch {
            held = OJ.read(file) // read-only home: what is there (or the defaults) still applies
        }
        let models = normalize(held ?? ModelDefaults.models)
        return only.map { InForce.onlyProviders(models, $0) } ?? models
    }
}

extension ModelsList {
    /// The list as the renderer received it (bart-models, settings-models), keys in order.
    public var json: OJ {
        func modelsJSON(_ m: Ordered<ModelInfo>) -> OJ { .object(m.pairs.map { ($0.0, ["id": .string($0.1.id), "name": .string($0.1.name), "use": .string($0.1.use)]) }) }
        func rungJSON(_ r: Rung) -> OJ { ["model": .string(r.model), "effort": .string(r.effort)] }
        var o: [(String, OJ)] = [("about", .string(about)), ("provider", .string(provider))]
        o.append(("providers", .object(providers.pairs.map { (k, e) in
            var p: [(String, OJ)] = [("name", .string(e.name)), ("models", modelsJSON(e.models)), ("efforts", .array(e.efforts.map { .string($0) })), ("ladder", .array(e.ladder.map(rungJSON)))]
            if let s = e.start { p.append(("start", rungJSON(s))) }
            return (k, .object(p))
        })))
        if let b = build {
            o.append(("build", ["about": .string(b.about), "provider": .string(b.provider), "providers": .object(b.providers.pairs.map { (k, e) in
                (k, ["models": modelsJSON(e.models), "efforts": .array(e.efforts.map { .string($0) }), "default": rungJSON(e.default)])
            })]))
        }
        if let b = brainstorm { o.append(("brainstorm", ["about": .string(b.about), "providers": .object(b.providers.pairs.map { ($0.0, rungJSON($0.1)) })])) }
        if let d = discover {
            o.append(("discover", ["about": .string(d.about), "providers": .object(d.providers.pairs.map { (k, levels) in
                (k, .object(Question.modes.compactMap { m in levels[m].map { (m, rungJSON($0)) } }))
            })]))
        }
        return .object(o)
    }
}

// in-force.cjs — the list a run starts on, made from the models file: cut to the providers config.json offers
// (onlyProviders), moved to the last pick by hand (startingAt) and to a provider whose CLI can run (preferUsable). Pure,
// so Settings › Intelligence shows the provider a run uses by the same rules a run does.
public enum InForce {
    /// Only the providers config.json lists; when it lists none of them, all stay, so a question can always run.
    public static func onlyProviders(_ models: ModelsList, _ only: [String]?) -> ModelsList {
        let kept = models.providers.keys.filter { only?.contains($0) == true }
        if kept.isEmpty { return models }
        var out = models
        if var build = models.build, !kept.contains(build.provider) { build.provider = kept[0]; out.build = build }
        out.provider = kept.contains(models.provider) ? models.provider : kept[0]
        out.providers = Ordered(kept.map { ($0, models.providers[$0]!) })
        return out
    }

    /// The saved default provider, or another one when the saved one cannot run (2026-09-23; D4), for @bart and Build.
    /// `usable`: the CLIs the last tool check found usable, or nil before the first check. Nothing is written.
    public static func preferUsable(_ models: ModelsList, _ usable: [String]?) -> ModelsList {
        guard let usable else { return models }
        func can(_ p: String) -> Bool { usable.contains(Models.toolOf[p] ?? "") }
        func moved(_ p: String) -> String { can(p) ? p : models.providers.keys.first(where: can) ?? p }
        var out = models
        out.provider = moved(models.provider)
        if var build = models.build { build.provider = moved(build.provider); out.build = build }
        return out
    }

    /// The list starting where the person last picked (`held`) for `place`: 'bart' → that provider becomes the default and
    /// its `start` the step a question without flags starts on; 'build' or 'quick' → Build's provider and its `default`.
    /// A pick the list no longer offers is ignored.
    public static func startingAt(_ models: ModelsList, _ place: String, _ held: Choice?) -> ModelsList {
        guard let held else { return models }
        var out = models
        if place == "bart" {
            guard var entry = models.providers[held.provider], entry.models[held.model] != nil, entry.efforts.contains(held.effort) else { return models }
            entry.start = Rung(model: held.model, effort: held.effort)
            out.provider = held.provider
            out.providers[held.provider] = entry
            return out
        }
        guard var build = models.build, models.providers[held.provider] != nil, var entry = build.providers[held.provider],
              entry.models[held.model] != nil, entry.efforts.contains(held.effort) else { return models }
        entry.default = Rung(model: held.model, effort: held.effort)
        build.provider = held.provider
        build.providers[held.provider] = entry
        out.build = build
        return out
    }
}
