import Foundation
import EngelbartCore

/// What a Build panel offers (bart/models.cjs buildChoices, B3): per provider its name, Build's models and efforts, and a
/// one-step `ladder` holding where the list starts (the last pick by hand, else the default). The models file belongs to
/// the Bart package; the app hands Build the choices in force (`readModels('build' | 'quick')`).
public struct BuildChoices: Sendable, Equatable {
    public struct Model: Sendable, Equatable {
        public var id: String
        public var name: String
        public var use: String
        public init(id: String, name: String, use: String = "") { self.id = id; self.name = name; self.use = use }
    }
    public struct Provider: Sendable, Equatable {
        public var name: String
        /// In the file's order.
        public var models: [(key: String, model: Model)]
        public var efforts: [String]
        /// The step the list starts on: { model, effort }.
        public var start: (model: String, effort: String)
        public init(name: String, models: [(key: String, model: Model)], efforts: [String], start: (model: String, effort: String)) {
            self.name = name; self.models = models; self.efforts = efforts; self.start = start
        }
        public func model(_ key: String) -> Model? { models.first { $0.key == key }?.model }
        public static func == (a: Provider, b: Provider) -> Bool {
            a.name == b.name && a.efforts == b.efforts && a.start == b.start && a.models.map(\.key) == b.models.map(\.key) && a.models.map(\.model) == b.models.map(\.model)
        }
    }
    /// The provider the panel starts on.
    public var provider: String
    /// In the file's order (openai, anthropic).
    public var providers: [(key: String, provider: Provider)]

    public init(provider: String, providers: [(key: String, provider: Provider)]) { self.provider = provider; self.providers = providers }

    public func entry(_ key: String) -> Provider? { providers.first { $0.key == key }?.provider }

    public static func == (a: BuildChoices, b: BuildChoices) -> Bool {
        a.provider == b.provider && a.providers.map(\.key) == b.providers.map(\.key) && a.providers.map(\.provider) == b.providers.map(\.provider)
    }

    /// Build's built-in block (DEFAULT_BUILD): Codex Luna/Sol/Astra (Sol high), Claude Code Sonnet/Opus/Fable (Opus high),
    /// the panel on Claude Code.
    public static let defaults = BuildChoices(provider: "anthropic", providers: [
        ("openai", Provider(name: "Codex", models: [
            ("luna", Model(id: "gpt-6-luna", name: "Luna", use: "Fastest. Small, clear changes.")),
            ("sol", Model(id: "gpt-6.1-sol", name: "Sol", use: "The default. Most Builds.")),
            ("astra", Model(id: "gpt-6-astra", name: "Astra", use: "Deepest. Hard changes across many files; slow.")),
        ], efforts: ["medium", "high", "xhigh", "ultra"], start: ("sol", "high"))),
        ("anthropic", Provider(name: "Claude Code", models: [
            ("sonnet", Model(id: "claude-sonnet-5-5", name: "Sonnet", use: "Fast. Small, clear changes.")),
            ("opus", Model(id: "opus", name: "Opus", use: "The default. Most Builds.")),
            ("fable", Model(id: "fable", name: "Fable", use: "Deepest. Hard changes across many files; slow.")),
        ], efforts: ["medium", "high", "xhigh", "max"], start: ("opus", "high"))),
    ])

    /// Read from the JSON `buildChoices` returns (`{ provider, providers: { key: { name, models, efforts, ladder } } }`).
    public init?(json: JSONValue) {
        guard let providers = json["providers"]?.object else { return nil }
        var list: [(String, Provider)] = []
        for key in ["openai", "anthropic"] + providers.keys.sorted().filter({ $0 != "openai" && $0 != "anthropic" }) {
            guard let p = providers[key], let models = p["models"]?.object else { continue }
            let ordered = models.keys.sorted { a, b in
                let order = ["luna", "sol", "astra", "haiku", "sonnet", "opus", "fable"]
                return (order.firstIndex(of: a) ?? 99, a) < (order.firstIndex(of: b) ?? 99, b)
            }
            let ms = ordered.compactMap { k -> (String, Model)? in
                guard let m = models[k], let id = m["id"]?.string else { return nil }
                return (k, Model(id: id, name: m["name"]?.string ?? k, use: m["use"]?.string ?? ""))
            }
            let efforts = p["efforts"]?.array?.compactMap(\.string) ?? []
            let step = p["ladder"]?[0] ?? p["default"]
            guard let model = step?["model"]?.string, let effort = step?["effort"]?.string, !ms.isEmpty else { continue }
            list.append((key, Provider(name: p["name"]?.string ?? key, models: ms, efforts: efforts, start: (model, effort))))
        }
        guard !list.isEmpty else { return nil }
        let start = json["provider"]?.string
        self.init(provider: list.contains { $0.0 == start } ? start! : list[0].0, providers: list)
    }

    /// The JSON shape `build-models` answers with (BartPicker reads it).
    public var json: JSONValue {
        var providers: [String: JSONValue] = [:]
        for (key, p) in self.providers {
            providers[key] = [
                "name": .string(p.name),
                "models": .object(Dictionary(uniqueKeysWithValues: p.models.map { ($0.key, ["id": .string($0.model.id), "name": .string($0.model.name), "use": .string($0.model.use)] as JSONValue) })),
                "efforts": .array(p.efforts.map(JSONValue.string)),
                "ladder": [["model": .string(p.start.model), "effort": .string(p.start.effort)]],
            ]
        }
        return ["provider": .string(provider), "providers": .object(providers)]
    }

    public struct Choice: Sendable, Equatable {
        public var provider: String
        public var model: String
        public var modelId: String
        public var modelName: String
        public var effort: String
        var record: TaskRecord {
            ["provider": .string(provider), "model": .string(model), "modelId": .string(modelId), "modelName": .string(modelName), "effort": .string(effort)]
        }
    }

    /// A pick from the panel made real: the model's id and name, the effort; the defaults when the pick names nothing
    /// Build knows (resolveBuildChoice).
    public func resolve(provider: String? = nil, model: String? = nil, effort: String? = nil) -> Choice {
        let at = provider.flatMap { entry($0) != nil ? $0 : nil } ?? self.provider
        let p = entry(at) ?? providers[0].provider
        let key = model.flatMap { p.model($0) != nil ? $0 : nil } ?? p.start.model
        let level = effort.flatMap { p.efforts.contains($0) ? $0 : nil } ?? p.start.effort
        let m = p.model(key) ?? p.models[0].model
        return Choice(provider: at, model: key, modelId: m.id, modelName: m.name, effort: level)
    }
}

/// Which CLI a provider is (tools/requirements.cjs TOOL_OF).
public enum ToolOf {
    public static func agent(_ provider: String) -> String { provider == "openai" ? "codex" : "claude" }
}

/// bart/question.cjs EFFORT_LABELS: how an effort is written on the chip and the card.
public enum EffortLabels {
    public static let labels = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
    public static func label(_ effort: String) -> String { labels[effort] ?? effort }
}
