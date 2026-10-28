import Foundation

// question.cjs — reading an @bart line (2026-09-20, taken out of models.cjs): which words are flags, which model and
// effort they pick, what is left as the question. Nothing here touches the disk, so the editor can use the same code:
// a flag it shows as recognised is one the run will obey.

/// A key-ordered dictionary: a provider's `models` keep the file's order, which is their rank (`above`).
public struct Ordered<V>: Sequence {
    public private(set) var keys: [String] = []
    private var values: [String: V] = [:]
    public init() {}
    public init(_ pairs: [(String, V)]) { for (k, v) in pairs { self[k] = v } }
    public subscript(key: String) -> V? {
        get { values[key] }
        set {
            if let newValue { if values[key] == nil { keys.append(key) }; values[key] = newValue }
            else { values[key] = nil; keys.removeAll { $0 == key } }
        }
    }
    public var isEmpty: Bool { keys.isEmpty }
    public var count: Int { keys.count }
    public var pairs: [(String, V)] { keys.map { ($0, values[$0]!) } }
    public func makeIterator() -> IndexingIterator<[(String, V)]> { pairs.makeIterator() }
    public func index(of key: String) -> Int { keys.firstIndex(of: key) ?? -1 }
    public var first: (String, V)? { keys.first.map { ($0, values[$0]!) } }
}

extension Ordered: Equatable where V: Equatable {
    public static func == (a: Ordered, b: Ordered) -> Bool { a.keys == b.keys && a.keys.allSatisfy { a[$0] == b[$0] } }
}
extension Ordered: @unchecked Sendable {}

public struct ModelInfo: Equatable, Sendable {
    public var id: String, name: String, use: String
    public init(id: String, name: String, use: String = "") { self.id = id; self.name = name; self.use = use }
}

/// A model key and an effort: a rung of a ladder, a default, a pick.
public struct Rung: Equatable, Sendable, Hashable {
    public var model: String, effort: String
    public init(model: String, effort: String) { self.model = model; self.effort = effort }
}

public struct ProviderEntry: Equatable, Sendable {
    public var name: String
    public var models: Ordered<ModelInfo>
    public var efforts: [String]
    public var ladder: [Rung]
    /// Where a question without flags starts: the last pick by hand (startingAt).
    public var start: Rung?
    public init(name: String, models: Ordered<ModelInfo>, efforts: [String], ladder: [Rung], start: Rung? = nil) {
        self.name = name; self.models = models; self.efforts = efforts; self.ladder = ladder; self.start = start
    }
    func usable(_ r: Rung?) -> Bool { guard let r else { return false }; return models[r.model] != nil && efforts.contains(r.effort) }
}

public struct BuildEntry: Equatable, Sendable {
    public var models: Ordered<ModelInfo>
    public var efforts: [String]
    public var `default`: Rung
}

public struct BuildBlock: Equatable, Sendable {
    public var about: String
    public var provider: String
    public var providers: Ordered<BuildEntry>
}

public struct BrainstormBlock: Equatable, Sendable {
    public var about: String
    public var providers: Ordered<Rung>
}

public struct DiscoverBlock: Equatable, Sendable {
    public var about: String
    /// provider → mode (quick, standard, deep) → rung.
    public var providers: Ordered<[String: Rung]>
}

/// The models file as the app reads it (models.cjs normalizeModels).
public struct ModelsList: Equatable, Sendable {
    public var about: String
    public var provider: String
    public var providers: Ordered<ProviderEntry>
    public var build: BuildBlock?
    public var brainstorm: BrainstormBlock?
    public var discover: DiscoverBlock?
    public init(about: String, provider: String, providers: Ordered<ProviderEntry>, build: BuildBlock? = nil, brainstorm: BrainstormBlock? = nil, discover: DiscoverBlock? = nil) {
        self.about = about; self.provider = provider; self.providers = providers; self.build = build; self.brainstorm = brainstorm; self.discover = discover
    }
}

/// A step a question runs on: { provider, key, model (the id the CLI gets), name, effort }.
public struct Step: Equatable, Sendable {
    public var provider: String, key: String, model: String, name: String, effort: String
    public init(provider: String, key: String, model: String, name: String, effort: String) {
        self.provider = provider; self.key = key; self.model = model; self.name = name; self.effort = effort
    }
}

/// A model picked by a word: { provider, model }.
public struct ModelPick: Equatable, Sendable { public var provider: String, model: String }

public struct Flags: Equatable, Sendable {
    public var chosen: ModelPick?
    public var effort: String?
    /// [start, end) of each flag in the text, UTF-16 offsets.
    public var spans: [[Int]]
    public var rest: String
}

/// readQuestion / readBrainstorm / readDiscover's result.
public struct QuestionRead: Equatable, Sendable {
    public var question: String
    public var provider: String
    public var steps: [Step]
    public var pinned: Bool
    /// @discover's mode (quick, standard, deep); nil for the others.
    public var mode: String?
}

public enum Question {
    // In rising order. Both CLIs were checked for the words they take (2026-09-21): Claude Code 2.1.278 `--effort` lists
    // low to max; codex-cli 0.155.1 knows none, minimal, low, medium, high, xhigh, max and ultra.
    public static let efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]
    public static let effortLabels = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
    public static let modes = ["quick", "standard", "deep"]

    static func squash(_ word: String?) -> String { JSRegex("[\\s_.-]+", "g").replace((word ?? "").lowercased(), with: "") }
    static let effortWords = ["low": "low", "lo": "low", "medium": "medium", "med": "medium", "mid": "medium", "high": "high", "hi": "high",
                              "xhigh": "xhigh", "extrahigh": "xhigh", "xtrahigh": "xhigh", "exhigh": "xhigh", "veryhigh": "xhigh",
                              "max": "max", "maximum": "max", "ultra": "ultra"]

    /// "Extra high", "x-high", " XHIGH " → "xhigh"; nil when the word is not an effort.
    public static func effortOf(_ word: String?) -> String? { effortWords[squash(word)] }

    /// "--Fable", "fable 5.1", "claude-opus-5", "gpt-5.6-sol" → { provider, model }; nil when the word names no model.
    public static func modelOf(_ word: String?, _ models: ModelsList) -> ModelPick? {
        func bareWord(_ v: String) -> String { JSRegex("[0-9]+", "g").replace(squash(v), with: "") }
        let wanted = bareWord(word ?? "")
        if wanted.isEmpty { return nil }
        let unprefixed = JSRegex("^(claude|gpt|codex)").replace(wanted, with: "")
        for (provider, entry) in models.providers {
            for (key, model) in entry.models {
                if wanted == key || wanted == bareWord(model.id) || wanted == bareWord(model.name) || unprefixed == key {
                    return ModelPick(provider: provider, model: key)
                }
            }
        }
        return nil
    }

    /// The flags of the text after "@bart", taken from either end; a `--word` that names neither a model nor an effort is
    /// not one and ends the taking.
    public static func readFlags(_ text: String?, _ models: ModelsList) -> Flags {
        let source = text ?? ""
        var words = JSRegex("\\S+", "g").matchAll(source).map { (word: $0.whole, start: $0.index, end: $0.index + $0.length) }
        var chosen: ModelPick? = nil
        var effort: String? = nil
        var spans: [[Int]] = []
        func take(_ fromStart: Bool) {
            while true {
                let at = fromStart ? 0 : words.count - 1
                guard at >= 0, at < words.count else { return }
                let held = words[at]
                guard JSRegex("^--\\S").test(held.word) else { return }
                let flag = held.word.jsSlice(2)
                let model = modelOf(flag, models)
                var level = effortOf(flag)
                var used = 1
                // "--extra high" and "--extra --high": two words, one effort.
                if model == nil && level == nil && squash(flag) == "extra" && fromStart && words.count > 1
                    && effortOf(JSRegex("^--").replace(words[1].word, with: "")) == "high" { level = "xhigh"; used = 2 }
                if model == nil && level == nil { return }
                if let model { chosen = model } else { effort = level }
                let start = fromStart ? 0 : at
                for taken in words[start..<min(words.count, start + used)] { spans.append([taken.start, taken.end]) }
                words.removeSubrange(start..<min(words.count, start + used))
            }
        }
        take(true)
        take(false)
        spans.sort { $0[0] < $1[0] }
        return Flags(chosen: chosen, effort: effort, spans: spans, rest: words.map { $0.word }.joined(separator: " "))
    }

    /// Whether `rung` is above `than` on a provider's list: a later model, or the same one at a higher effort.
    public static func above(_ entry: ProviderEntry, _ rung: Rung, _ than: Rung) -> Bool {
        let order = entry.models.keys
        let a = order.firstIndex(of: rung.model) ?? -1, b = order.firstIndex(of: than.model) ?? -1
        return a > b || (rung.model == than.model && (efforts.firstIndex(of: rung.effort) ?? -1) > (efforts.firstIndex(of: than.effort) ?? -1))
    }

    /// The steps a question without flags climbs: the ladder, or, when the person last picked by hand (`start`), that pick
    /// and then the ladder's steps above it.
    public static func ladderOf(_ entry: ProviderEntry) -> [Rung] {
        guard let start = entry.start, entry.usable(start) else { return entry.ladder }
        return [start] + entry.ladder.filter { above(entry, $0, start) }
    }

    /// The text after "@bart" → { question, provider, steps, pinned }; one step when pinned.
    public static func readQuestion(_ text: String?, _ models: ModelsList) -> QuestionRead {
        let flags = readFlags(text, models)
        var effort = flags.effort
        let provider = flags.chosen?.provider ?? models.provider
        let entry = models.providers[provider]!
        // An effort the list does not offer becomes the nearest one it does, the higher of two equally near.
        if let e = effort, !entry.efforts.contains(e) {
            func rank(_ v: String) -> Int { efforts.firstIndex(of: v) ?? -1 }
            let want = rank(e)
            effort = entry.efforts.enumerated().sorted { x, y in
                let dx = abs(rank(x.element) - want), dy = abs(rank(y.element) - want)
                if dx != dy { return dx < dy }
                if rank(x.element) != rank(y.element) { return rank(x.element) > rank(y.element) }
                return x.offset < y.offset
            }.first?.element
        }
        func step(_ rung: Rung) -> Step {
            let m = entry.models[rung.model]!
            return Step(provider: provider, key: rung.model, model: m.id, name: m.name, effort: rung.effort)
        }
        let pinned = flags.chosen != nil || effort != nil
        if !pinned { return QuestionRead(question: flags.rest, provider: provider, steps: ladderOf(entry).map(step), pinned: false) }
        // One of the two by hand: the other comes from the step that already pairs with it, the one it would start on first.
        let rungs = ladderOf(entry) + entry.ladder
        let rung: Rung
        if let chosen = flags.chosen {
            rung = Rung(model: chosen.model, effort: effort ?? (rungs.first { $0.model == chosen.model }?.effort ?? "medium"))
        } else {
            rung = Rung(model: (rungs.first { $0.effort == effort } ?? rungs[0]).model, effort: effort!)
        }
        return QuestionRead(question: flags.rest, provider: provider, steps: [step(rung)], pinned: true)
    }

    // How far @discover traces: `--quick`, `--standard` or `--deep`, anywhere on the line.
    static let modeRE = JSRegex("(^|\\s)--(quick|standard|deep)(?=\\s|$)", "gi")
    static let providerRE = JSRegex("(^|\\s)--(claude|codex|chatgpt)(?=\\s|$)", "gi")
    static let providerWords = ["claude": "anthropic", "codex": "openai", "chatgpt": "openai"]
    /// The flag withMode writes for each.
    public static let providerFlags = ["anthropic": "--claude", "openai": "--codex"]
    // A Refine turn (2026-10-15, David): `--refine` on an @discover line.
    static let refineRE = JSRegex("(^|\\s)(--refine)(?=\\s|$)", "gi")

    /// The mode an @discover line names, the last when it names two, else nil; and the line without it.
    public static func readMode(_ text: String?) -> (mode: String?, rest: String) {
        var mode: String? = nil
        let rest = modeRE.replace(text ?? "") { m in mode = m[2]!.lowercased(); return m[1] ?? "" }.squashedSpaces
        return (mode, rest)
    }

    /// Whether an @discover line is a Refine turn, and the line without the flag.
    public static func readRefine(_ text: String?) -> (refine: Bool, rest: String) {
        var refine = false
        let rest = refineRE.replace(text ?? "") { m in refine = true; return m[1] ?? "" }.squashedSpaces
        return (refine, rest)
    }

    /// The provider an @discover line names, the last when it names two, else nil; and the line without it.
    public static func readProvider(_ text: String?) -> (provider: String?, rest: String) {
        var provider: String? = nil
        let rest = providerRE.replace(text ?? "") { m in provider = providerWords[m[2]!.lowercased()]; return m[1] ?? "" }.squashedSpaces
        return (provider, rest)
    }

    /// `mode`'s level of @discover on `provider`: the models file's `discover` block, else that provider's first step.
    public static func levelOf(_ models: ModelsList, _ provider: String, _ mode: String) -> Rung {
        let entry = models.providers[provider]!
        if let held = models.discover?.providers[provider]?[mode], entry.usable(held) { return held }
        return entry.ladder[0]
    }

    /// The text after "@discover" → one step and its `mode`: the one the line names, else the last one an earlier turn
    /// named, else 'standard'. The provider likewise (`--claude`, `--codex`), else the @bart default; one the list does not
    /// offer is passed over. A model or effort flag still picks by hand for that line.
    public static func readDiscover(_ text: String?, _ models: ModelsList, _ earlier: [String] = []) -> QuestionRead {
        func offered(_ p: String?) -> String? { p.flatMap { models.providers[$0] != nil ? $0 : nil } }
        let (named, unmoded) = readMode(readRefine(text).rest)
        let (asked, rest) = readProvider(unmoded)
        let before = earlier.reversed()
        let carried = before.lazy.compactMap { readMode($0).mode }.first
        let mode = named ?? carried ?? "standard"
        let provider = offered(asked) ?? before.lazy.compactMap { offered(readProvider($0).provider) }.first ?? models.provider
        var m = models; m.provider = provider
        var read = readQuestion(rest, m)
        if read.pinned { read.mode = mode; return read }
        let entry = models.providers[provider]!, rung = levelOf(models, provider, mode)
        let info = entry.models[rung.model]!
        return QuestionRead(question: read.question, provider: provider,
                            steps: [Step(provider: provider, key: rung.model, model: info.id, name: info.name, effort: rung.effort)], pinned: false, mode: mode)
    }

    /// The text after "@discover" set to run at `mode` on `provider` (the line's level chip): every mode and provider flag
    /// and every model or effort flag taken off, then `--claude`/`--codex` and `--quick`/`--standard`/`--deep`. `plainMode`/
    /// `plainProvider` are how the line runs with no flag; picking either writes nothing, so a plain line stays plain.
    public static func withMode(_ text: String?, _ mode: String, _ models: ModelsList?, plainMode: String = "standard", plainProvider: String? = nil, provider: String? = nil) -> String {
        let pProvider = plainProvider ?? models?.provider
        let rest = readProvider(readMode(text).rest).rest
        let question = models.map { readFlags(rest, $0).rest } ?? rest
        var named = ""
        if let provider, provider != pProvider, models == nil || models!.providers[provider] != nil { named = providerFlags[provider] ?? "" }
        let modeFlag = modes.contains(mode) && mode != plainMode ? "--\(mode)" : ""
        return [question, named, modeFlag].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Where the flags of an @discover line are, [start, end) each, for the editor to mark.
    public static func discoverSpans(_ text: String?, _ models: ModelsList?) -> [[Int]] {
        var spans: [[Int]] = []
        func blankOut(_ source: String, _ re: JSRegex) -> String {
            re.replace(source) { m in
                let lead = m[1] ?? ""
                spans.append([m.index + lead.jsLength, m.index + m.length])
                return lead + String(repeating: " ", count: m.length - lead.jsLength)
            }
        }
        let blank = blankOut(blankOut(blankOut(text ?? "", modeRE), providerRE), refineRE)
        if let models { spans += readFlags(blank, models).spans }
        return spans.sorted { $0[0] < $1[0] }
    }

    // A full Build of what follows (2026-10-02): `--build` anywhere on an @bart line, in any case.
    static let buildRE = JSRegex("(^|\\s)--build(?=\\s|$)", "gi")

    /// The text after "@bart" → whether it says --build, and what is left without it (and without model/effort flags when
    /// `models` is given).
    public static func readBuildFlag(_ text: String?, _ models: ModelsList? = nil) -> (build: Bool, rest: String) {
        var build = false
        let without = buildRE.replace(text ?? "") { m in build = true; return m[1] ?? "" }.squashedSpaces
        return (build, models.map { readFlags(without, $0).rest } ?? without)
    }

    /// What an ask is when it is a Build: the request (empty when nothing follows the flag), or nil for an ask. Only an
    /// @chat line (agent 'bart') or an @bart line (the router) builds.
    public static func buildRequestOf(agent: String? = "bart", text: String?, _ models: ModelsList? = nil) -> String? {
        guard ["bart", "router"].contains(agent ?? "bart") else { return nil }
        let r = readBuildFlag(text, models)
        return r.build ? r.rest : nil
    }

    /// The text after "@bart" with its flags replaced by the two that name this model and effort.
    public static func withChoice(_ text: String?, _ models: ModelsList, model: String, effort: String) -> String {
        let rest = readFlags(text, models).rest
        return ["--\(model)", "--\(effort)", rest].filter { !$0.isEmpty }.joined(separator: " ")
    }
}
