import Foundation
import EngelbartDoc

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


// The line itself is read by the Doc package's `Question` (question.cjs, one definition shared with the editor). What
// follows are its calls on the models file as Bart keeps it (`ModelsList`, with each model's `use`, Build's, Brainstorm's
// and Discover's blocks), and Bart's step type.

extension ModelsList {
    /// The list as Doc's question reader takes it: providers and models in order, efforts, ladders, the last pick
    /// (`start`), and @discover's levels.
    public var questionModels: QuestionModels {
        var discoverLevels: [String: [String: QuestionModels.Rung]] = [:]
        for (p, levels) in discover?.providers ?? Ordered() {
            discoverLevels[p] = levels.mapValues { QuestionModels.Rung(model: $0.model, effort: $0.effort) }
        }
        return QuestionModels(provider: provider, providers: providers.pairs.map { key, e in
            QuestionModels.Provider(key: key, name: e.name, models: e.models.pairs.map { QuestionModels.Model(key: $0.0, id: $0.1.id, name: $0.1.name) },
                                    efforts: e.efforts, ladder: e.ladder.map { QuestionModels.Rung(model: $0.model, effort: $0.effort) },
                                    start: e.start.map { QuestionModels.Rung(model: $0.model, effort: $0.effort) })
        }, discover: discoverLevels)
    }
}

extension ProviderEntry {
    func questionProvider(_ key: String) -> QuestionModels.Provider {
        QuestionModels.Provider(key: key, name: name, models: models.pairs.map { QuestionModels.Model(key: $0.0, id: $0.1.id, name: $0.1.name) },
                                efforts: efforts, ladder: ladder.map { QuestionModels.Rung(model: $0.model, effort: $0.effort) },
                                start: start.map { QuestionModels.Rung(model: $0.model, effort: $0.effort) })
    }
}

extension Question {
    public static var efforts: [String] { EFFORTS }
    public static var effortLabels: [String: String] { EFFORT_LABELS }
    public static var modes: [String] { MODES }

    static func read(_ r: Question.Read) -> QuestionRead {
        QuestionRead(question: r.question, provider: r.provider, steps: r.steps.map { EngelbartBart.Step(provider: $0.provider, key: $0.key, model: $0.model, name: $0.name, effort: $0.effort) },
                     pinned: r.pinned, mode: r.mode)
    }

    public static func modelOf(_ word: String?, _ models: ModelsList) -> ModelPick? {
        modelOf(word ?? "", models.questionModels).map { ModelPick(provider: $0.provider, model: $0.model) }
    }

    public static func readFlags(_ text: String?, _ models: ModelsList) -> EngelbartBart.Flags {
        let f = readFlags(text, models.questionModels)
        return EngelbartBart.Flags(chosen: f.chosen.map { ModelPick(provider: $0.provider, model: $0.model) }, effort: f.effort, spans: f.spans, rest: f.rest)
    }

    public static func above(_ entry: ProviderEntry, _ rung: Rung, _ than: Rung) -> Bool {
        above(entry.questionProvider(""), QuestionModels.Rung(model: rung.model, effort: rung.effort), QuestionModels.Rung(model: than.model, effort: than.effort))
    }

    public static func ladderOf(_ entry: ProviderEntry) -> [Rung] {
        ladderOf(entry.questionProvider("")).map { Rung(model: $0.model, effort: $0.effort) }
    }

    public static func readQuestion(_ text: String?, _ models: ModelsList) -> QuestionRead { read(readQuestion(text, models.questionModels)) }

    public static func levelOf(_ models: ModelsList, _ provider: String, _ mode: String) -> Rung {
        let r = levelOf(models.questionModels, provider, mode)
        return Rung(model: r.model, effort: r.effort)
    }

    public static func readDiscover(_ text: String?, _ models: ModelsList, _ earlier: [String] = []) -> QuestionRead {
        read(readDiscover(text, models.questionModels, earlier: earlier))
    }

    public static func withMode(_ text: String?, _ mode: String, _ models: ModelsList?, plainMode: String = "standard", plainProvider: String? = nil, provider: String? = nil) -> String {
        withMode(text, mode, models?.questionModels, plainMode: plainMode, plainProvider: plainProvider, provider: provider)
    }

    public static func discoverSpans(_ text: String?, _ models: ModelsList?) -> [[Int]] { discoverSpans(text, models?.questionModels) }

    public static func readBuildFlag(_ text: String?, _ models: ModelsList) -> (build: Bool, rest: String) { readBuildFlag(text, models.questionModels) }

    public static func buildRequestOf(agent: String?, text: String?, _ models: ModelsList) -> String? { buildRequestOf(agent: agent, text: text, models.questionModels) }

    public static func withChoice(_ text: String?, _ models: ModelsList, model: String, effort: String) -> String {
        withChoice(text, models.questionModels, model: model, effort: effort)
    }
}
