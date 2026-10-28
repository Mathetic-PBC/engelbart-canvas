import Foundation
import EngelbartCore
import EngelbartBuild

/// A pick of the grid: { provider, model, effort }.
public struct ModelChoice: Equatable, Sendable {
    public var provider: String, model: String, effort: String
    public init(provider: String, model: String, effort: String) { self.provider = provider; self.model = model; self.effort = effort }
    var json: JSONValue { ["provider": .string(provider), "model": .string(model), "effort": .string(effort)] }
}

/// The pure parts of the model and effort grid (post-its/ModelGrid.jsx) and where the Build popup starts
/// (PostItBuild.jsx startingChoice). `models` is what `build-models` answers (BuildChoices).
public enum ModelPick {
    /// The provider a model key belongs to (keys are unique across providers).
    public static func providerOf(_ models: BuildChoices, _ key: String) -> String {
        models.providers.first { $0.provider.model(key) != nil }?.key ?? models.provider
    }

    /// The effort a model starts at when picked: the one it was last given, else its provider's default when it is that
    /// model's, else the provider's first step's effort when offered, else its first effort.
    public static func effortFor(_ models: BuildChoices, _ key: String, efforts: [String: String] = [:]) -> String {
        guard let entry = models.entry(providerOf(models, key)) else { return "" }
        if let kept = efforts[key], entry.efforts.contains(kept) { return kept }
        if entry.start.model == key { return entry.start.effort }
        return entry.efforts.contains(entry.start.effort) ? entry.start.effort : (entry.efforts.first ?? "")
    }

    /// "Opus High": what a chip or the popup's foot says ('' when the choice names nothing offered).
    public static func choiceLabel(_ models: BuildChoices?, _ choice: ModelChoice?) -> String {
        guard let models, let choice, let model = models.entry(choice.provider)?.model(choice.model) else { return "" }
        return "\(model.name) \(EffortLabels.label(choice.effort))"
    }

    static func offered(_ models: BuildChoices, _ held: ModelChoice) -> Bool {
        guard let entry = models.entry(held.provider) else { return false }
        return entry.model(held.model) != nil && entry.efforts.contains(held.effort)
    }

    /// Where the popup starts: what main says (the last 'quick' pick, else the default); a pick this window kept before
    /// main did (an older build's localStorage `{ provider, model, effort, efforts }`), once — handed to main and dropped.
    public static func startingChoice(_ models: BuildChoices, kept: PickMemory, remember: (ModelChoice) -> Void) -> ModelChoice {
        let held = kept.read()
        if let provider = held?["provider"]?.string, !provider.isEmpty {
            kept.write(["efforts": held?["efforts"] ?? .object([:])])
            let pick = ModelChoice(provider: provider, model: held?["model"]?.string ?? "", effort: held?["effort"]?.string ?? "")
            if offered(models, pick) {
                remember(pick)
                return pick
            }
        }
        let p = models.entry(models.provider) ?? models.providers[0].provider
        return ModelChoice(provider: models.provider, model: p.start.model, effort: p.start.effort)
    }
}

/// `localStorage['engelbart.postIt.build']`: the effort last used with each model ({ efforts }), kept by the app in
/// UserDefaults under the same key. Before 2026-09-29 the pick itself was kept here too.
public final class PickMemory: @unchecked Sendable {
    public static let key = "engelbart.postIt.build"
    let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func read() -> JSONValue? {
        guard let text = defaults.string(forKey: PickMemory.key) else { return nil }
        return try? JSONValue.parse(text)
    }
    /// A convenience only: nothing fails when it cannot be kept.
    public func write(_ value: JSONValue) { defaults.set(value.text(), forKey: PickMemory.key) }
    public var efforts: [String: String] {
        (read()?["efforts"]?.object ?? [:]).compactMapValues { $0.string }
    }
}
