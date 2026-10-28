import Foundation
import EngelbartCore

// Reading an @bart line (src/main/bart/question.cjs, 2026-09-20): which words are flags, which model and effort they pick,
// what is left as the question. Nothing here touches the disk, so the editor and main share it: a flag the editor shows
// as recognised is one the run will obey. Bart (main) uses this same file through EngelbartDoc.

/// The models file as question.cjs reads it: providers in order, each with its models in order (the order ranks them).
public struct QuestionModels: Equatable, Sendable {
    public struct Model: Equatable, Sendable { public var key: String; public var id: String; public var name: String
        public init(key: String, id: String, name: String) { self.key = key; self.id = id; self.name = name } }
    public struct Rung: Equatable, Sendable { public var model: String; public var effort: String
        public init(model: String, effort: String) { self.model = model; self.effort = effort } }
    public struct Provider: Equatable, Sendable {
        public var key: String
        public var name: String
        public var models: [Model]
        public var efforts: [String]
        public var ladder: [Rung]
        /// The last pick by hand (models.cjs startingAt), the ladder's start when set.
        public var start: Rung?
        public init(key: String, name: String, models: [Model], efforts: [String], ladder: [Rung], start: Rung? = nil) {
            self.key = key; self.name = name; self.models = models; self.efforts = efforts; self.ladder = ladder; self.start = start
        }
        public func model(_ key: String) -> Model? { models.first { $0.key == key } }
    }
    /// The default provider.
    public var provider: String
    public var providers: [Provider]
    /// @discover's levels per provider: provider → mode → rung.
    public var discover: [String: [String: Rung]]
    public init(provider: String, providers: [Provider], discover: [String: [String: Rung]] = [:]) { self.provider = provider; self.providers = providers; self.discover = discover }
    public func entry(_ key: String) -> Provider? { providers.first { $0.key == key } }

    /// models.cjs DEFAULT_MODELS (2026-10-12), in its key order: openai before anthropic, models cheapest first.
    public static let defaults = QuestionModels(provider: "anthropic", providers: [
        Provider(key: "openai", name: "Codex", models: [Model(key: "luna", id: "gpt-6-luna", name: "Luna"), Model(key: "sol", id: "gpt-6.1-sol", name: "Sol"), Model(key: "astra", id: "gpt-6-astra", name: "Astra")],
                 efforts: ["low", "medium", "high", "xhigh", "ultra"], ladder: [Rung(model: "sol", effort: "medium"), Rung(model: "sol", effort: "high"), Rung(model: "astra", effort: "xhigh")]),
        Provider(key: "anthropic", name: "Claude Code", models: [Model(key: "haiku", id: "claude-haiku-5-5", name: "Haiku"), Model(key: "sonnet", id: "claude-sonnet-5-5", name: "Sonnet"), Model(key: "opus", id: "opus", name: "Opus"), Model(key: "fable", id: "fable", name: "Fable")],
                 efforts: ["low", "medium", "high", "xhigh", "max"], ladder: [Rung(model: "sonnet", effort: "high"), Rung(model: "opus", effort: "high"), Rung(model: "fable", effort: "xhigh")]),
    ], discover: [
        "openai": ["quick": Rung(model: "sol", effort: "medium"), "standard": Rung(model: "astra", effort: "high"), "deep": Rung(model: "astra", effort: "ultra")],
        "anthropic": ["quick": Rung(model: "sonnet", effort: "medium"), "standard": Rung(model: "opus", effort: "high"), "deep": Rung(model: "opus", effort: "max")],
    ])

    /// From the models file's JSON (normalized by main). JSON objects carry no key order here, so providers and models are
    /// ordered as the shipped defaults list them, anything else after, alphabetically.
    public init?(json: JSONValue) {
        guard let providers = json["providers"]?.object else { return nil }
        let providerRank = ["openai", "anthropic"]
        let modelRank = ["luna", "sol", "astra", "haiku", "sonnet", "opus", "fable"]
        func ranked(_ keys: [String], _ rank: [String]) -> [String] {
            keys.sorted { a, b in
                let ra = rank.firstIndex(of: a) ?? Int.max, rb = rank.firstIndex(of: b) ?? Int.max
                return ra != rb ? ra < rb : a < b
            }
        }
        func rung(_ v: JSONValue?) -> Rung? { guard let m = v?["model"]?.string, let e = v?["effort"]?.string else { return nil }; return Rung(model: m, effort: e) }
        var list: [Provider] = []
        for key in ranked(Array(providers.keys), providerRank) {
            guard let p = providers[key], let models = p["models"]?.object else { continue }
            list.append(Provider(key: key, name: p["name"]?.string ?? key,
                                 models: ranked(Array(models.keys), modelRank).map { Model(key: $0, id: models[$0]?["id"]?.string ?? $0, name: models[$0]?["name"]?.string ?? $0) },
                                 efforts: p["efforts"]?.array?.compactMap { $0.string } ?? [],
                                 ladder: p["ladder"]?.array?.compactMap { rung($0) } ?? [],
                                 start: rung(p["start"])))
        }
        var discover: [String: [String: Rung]] = [:]
        for (key, levels) in json["discover"]?["providers"]?.object ?? [:] {
            var out: [String: Rung] = [:]
            for (mode, v) in levels.object ?? [:] { if let r = rung(v) { out[mode] = r } }
            discover[key] = out
        }
        self.init(provider: json["provider"]?.string ?? "anthropic", providers: list, discover: discover)
    }
}

public enum Question {
    /// In rising order.
    public static let EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"]
    public static let EFFORT_LABELS = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
    public static let MODES = ["quick", "standard", "deep"]

    static func squash(_ word: String?) -> String { Rx(#"[\s_.-]+"#).replace((word ?? "").lowercased(), with: "") }
    static let EFFORT_WORDS = ["low": "low", "lo": "low", "medium": "medium", "med": "medium", "mid": "medium", "high": "high", "hi": "high", "xhigh": "xhigh", "extrahigh": "xhigh", "xtrahigh": "xhigh", "exhigh": "xhigh", "veryhigh": "xhigh", "max": "max", "maximum": "max", "ultra": "ultra"]

    /// "Extra high", "x-high", " XHIGH " → "xhigh"; nil when the word is not an effort.
    public static func effortOf(_ word: String?) -> String? { EFFORT_WORDS[squash(word)] }

    public struct Chosen: Equatable { public var provider: String; public var model: String }

    /// "--Fable", "fable 5.1", "claude-opus-5" → (provider, model key); nil when the word names no model in the list.
    public static func modelOf(_ word: String, _ models: QuestionModels) -> Chosen? {
        func bare(_ v: String) -> String { Rx(#"\d+"#).replace(squash(v), with: "") }
        let wanted = bare(word)
        if wanted.isEmpty { return nil }
        for p in models.providers {
            for m in p.models where wanted == m.key || wanted == bare(m.id) || wanted == bare(m.name) || Rx(#"^(claude|gpt|codex)"#).replace(wanted, with: "", global: false) == m.key {
                return Chosen(provider: p.key, model: m.key)
            }
        }
        return nil
    }

    public struct Flags: Equatable { public var chosen: Chosen?; public var effort: String?; public var spans: [[Int]]; public var rest: String }

    /// The flags of the text after "@bart", taken from either end; a `--word` that names neither a model nor an effort ends
    /// the taking.
    public static func readFlags(_ text: String?, _ models: QuestionModels) -> Flags {
        let source = text ?? ""
        var words = Rx(#"\S+"#).matchAll(source).map { (word: $0.str, start: $0.index, end: $0.end) }
        var chosen: Chosen? = nil, effort: String? = nil
        var spans: [[Int]] = []
        func take(_ fromStart: Bool) {
            while true {
                let at = fromStart ? 0 : words.count - 1
                guard at >= 0, at < words.count, Rx(#"^--\S"#).test(words[at].word) else { return }
                let flag = words[at].word.slice(2)
                let model = modelOf(flag, models)
                var level = effortOf(flag)
                var used = 1
                // "--extra high" and "--extra --high": two words, one effort.
                if model == nil && level == nil && squash(flag) == "extra" && fromStart && words.count > 1 && effortOf(Rx(#"^--"#).replace(words[1].word, with: "")) == "high" { level = "xhigh"; used = 2 }
                if model == nil && level == nil { return }
                if let model { chosen = model } else { effort = level }
                let range = fromStart ? 0..<used : at..<(at + used)
                for taken in words[range] { spans.append([taken.start, taken.end]) }
                words.removeSubrange(range)
            }
        }
        take(true)
        take(false)
        spans.sort { $0[0] < $1[0] }
        return Flags(chosen: chosen, effort: effort, spans: spans, rest: words.map { $0.word }.joined(separator: " "))
    }

    /// Whether `rung` is above `than` on a provider's list.
    public static func above(_ entry: QuestionModels.Provider, _ rung: QuestionModels.Rung, _ than: QuestionModels.Rung) -> Bool {
        let order = entry.models.map { $0.key }
        let a = order.firstIndex(of: rung.model) ?? -1, b = order.firstIndex(of: than.model) ?? -1
        return a > b || (rung.model == than.model && (EFFORTS.firstIndex(of: rung.effort) ?? -1) > (EFFORTS.firstIndex(of: than.effort) ?? -1))
    }

    /// The steps a question without flags climbs.
    public static func ladderOf(_ entry: QuestionModels.Provider) -> [QuestionModels.Rung] {
        guard let start = entry.start, entry.model(start.model) != nil, entry.efforts.contains(start.effort) else { return entry.ladder }
        return [start] + entry.ladder.filter { above(entry, $0, start) }
    }

    public struct Step: Equatable { public var provider: String; public var key: String; public var model: String; public var name: String; public var effort: String }
    public struct Read: Equatable { public var question: String; public var provider: String; public var steps: [Step]; public var pinned: Bool; public var mode: String? = nil }

    /// The text after "@bart" → the question, its provider, the steps it climbs (one when pinned by hand).
    public static func readQuestion(_ text: String?, _ models: QuestionModels) -> Read {
        let f = readFlags(text, models)
        var effort = f.effort
        let provider = f.chosen?.provider ?? models.provider
        let entry = models.entry(provider) ?? models.providers[0]
        // An effort the list does not offer becomes the nearest one it does, the higher of two equally near.
        if let e = effort, !entry.efforts.contains(e) {
            let rank = { (v: String) in EFFORTS.firstIndex(of: v) ?? -1 }
            effort = entry.efforts.sorted { a, b in
                let da = abs(rank(a) - rank(e)), db = abs(rank(b) - rank(e))
                return da != db ? da < db : rank(b) < rank(a)
            }.first
        }
        func step(_ r: QuestionModels.Rung) -> Step {
            let m = entry.model(r.model)
            return Step(provider: provider, key: r.model, model: m?.id ?? r.model, name: m?.name ?? r.model, effort: r.effort)
        }
        let pinned = f.chosen != nil || effort != nil
        if !pinned { return Read(question: f.rest, provider: provider, steps: ladderOf(entry).map(step), pinned: false) }
        let rungs = ladderOf(entry) + entry.ladder
        let rung: QuestionModels.Rung
        if let chosen = f.chosen {
            rung = .init(model: chosen.model, effort: effort ?? (rungs.first { $0.model == chosen.model }?.effort ?? "medium"))
        } else {
            rung = .init(model: (rungs.first { $0.effort == effort } ?? rungs[0]).model, effort: effort!)
        }
        return Read(question: f.rest, provider: provider, steps: [step(rung)], pinned: true)
    }

    static let MODE = Rx(#"(^|\s)--(quick|standard|deep)(?=\s|$)"#, "i")
    static let PROVIDER = Rx(#"(^|\s)--(claude|codex|chatgpt)(?=\s|$)"#, "i")
    static let PROVIDER_WORDS = ["claude": "anthropic", "codex": "openai", "chatgpt": "openai"]
    static let PROVIDER_FLAGS = ["anthropic": "--claude", "openai": "--codex"]
    static let REFINE = Rx(#"(^|\s)(--refine)(?=\s|$)"#, "i")
    static let BUILD = Rx(#"(^|\s)--build(?=\s|$)"#, "i")

    static func squeeze(_ s: String) -> String { Rx(#"\s+"#).replace(s, with: " ").trimmed }

    /// The mode an @discover line names (the last of two), and the line without it.
    public static func readMode(_ text: String?) -> (mode: String?, rest: String) {
        var mode: String? = nil
        let rest = MODE.replace(text ?? "") { m in mode = m[2]!.lowercased(); return m[1] ?? "" }
        return (mode, squeeze(rest))
    }
    public static func readRefine(_ text: String?) -> (refine: Bool, rest: String) {
        var refine = false
        let rest = REFINE.replace(text ?? "") { m in refine = true; return m[1] ?? "" }
        return (refine, squeeze(rest))
    }
    public static func readProvider(_ text: String?) -> (provider: String?, rest: String) {
        var provider: String? = nil
        let rest = PROVIDER.replace(text ?? "") { m in provider = PROVIDER_WORDS[m[2]!.lowercased()]; return m[1] ?? "" }
        return (provider, squeeze(rest))
    }

    /// `mode`'s level of @discover on `provider`: the models file's `discover` block, else that provider's first step.
    public static func levelOf(_ models: QuestionModels, _ provider: String, _ mode: String) -> QuestionModels.Rung {
        let entry = models.entry(provider)!
        if let held = models.discover[provider]?[mode], entry.model(held.model) != nil, entry.efforts.contains(held.effort) { return held }
        return entry.ladder[0]
    }

    /// The text after "@discover" → readQuestion's answer on one step, and its `mode`.
    public static func readDiscover(_ text: String?, _ models: QuestionModels, earlier: [String] = []) -> Read {
        func offered(_ p: String?) -> String? { p.flatMap { models.entry($0) != nil ? $0 : nil } }
        let (named, unmoded) = readMode(readRefine(text).rest)
        let (asked, rest) = readProvider(unmoded)
        let before = earlier.reversed()
        let carried = before.lazy.compactMap { readMode($0).mode }.first
        let mode = named ?? carried ?? "standard"
        let provider = offered(asked) ?? before.lazy.compactMap { offered(readProvider($0).provider) }.first ?? models.provider
        var m = models; m.provider = provider
        var read = readQuestion(rest, m)
        if read.pinned { read.mode = mode; return read }
        let entry = models.entry(provider)!, rung = levelOf(models, provider, mode)
        let model = entry.model(rung.model)
        return Read(question: read.question, provider: provider, steps: [Step(provider: provider, key: rung.model, model: model?.id ?? rung.model, name: model?.name ?? rung.model, effort: rung.effort)], pinned: false, mode: mode)
    }

    /// The text after "@discover" set to run at `mode` on `provider` (2026-10-03, the line's level chip).
    public static func withMode(_ text: String?, _ mode: String, _ models: QuestionModels?, plainMode: String = "standard", plainProvider: String? = nil, provider: String? = nil) -> String {
        let pp = plainProvider ?? models?.provider
        let rest = readProvider(readMode(text).rest).rest
        let question = models.map { readFlags(rest, $0).rest } ?? rest
        var named = ""
        if let provider, provider != pp, models == nil || models!.entry(provider) != nil { named = PROVIDER_FLAGS[provider] ?? "" }
        let flag = MODES.contains(mode) && mode != plainMode ? "--\(mode)" : ""
        return [question, named, flag].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Where the flags of an @discover line are, [start, end) each, for the editor to mark.
    public static func discoverSpans(_ text: String?, _ models: QuestionModels?) -> [[Int]] {
        var spans: [[Int]] = []
        func blankOut(_ source: String, _ re: Rx) -> String {
            re.replace(source) { m in
                let lead = (m[1] ?? "").len
                spans.append([m.index + lead, m.end])
                return (m[1] ?? "") + " ".repeated(m.length - lead)
            }
        }
        let blank = blankOut(blankOut(blankOut(text ?? "", MODE), PROVIDER), REFINE)
        if let models { spans += readFlags(blank, models).spans }
        return spans.sorted { $0[0] < $1[0] }
    }

    /// The text after "@bart" → whether it says --build, and what is left without it (and the flags, given models).
    public static func readBuildFlag(_ text: String?, _ models: QuestionModels? = nil) -> (build: Bool, rest: String) {
        var build = false
        let without = squeeze(BUILD.replace(text ?? "") { m in build = true; return m[1] ?? "" })
        return (build, models.map { readFlags(without, $0).rest } ?? without)
    }

    /// What an ask is when it is a Build: its request (empty when nothing follows the flag), or nil for an ask. Only an
    /// @chat line (agent 'bart') or an @bart line (the router) builds.
    public static func buildRequestOf(agent: String?, text: String?, _ models: QuestionModels? = nil) -> String? {
        guard ["bart", "router"].contains(agent ?? "bart") else { return nil }
        let r = readBuildFlag(text, models)
        return r.build ? r.rest : nil
    }

    /// The text after "@bart" with its flags replaced by the two that name this model and effort.
    public static func withChoice(_ text: String?, _ models: QuestionModels, model: String, effort: String) -> String {
        ["--\(model)", "--\(effort)", readFlags(text, models).rest].filter { !$0.isEmpty }.joined(separator: " ")
    }
}
