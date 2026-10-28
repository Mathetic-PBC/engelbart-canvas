import Foundation

// choices.cjs — the model and effort last picked by hand, one for each place that picks (2026-09-29): @bart (a question
// asked with flags, from the chip's selector or Regenerate), a workspace's Build panel, and a post-it's quick task. Each
// is where the next one starts (InForce.startingAt). One file for every project, beside the models file:
// <home>/model-choices.json. It holds keys only; they are checked against the list in force each time. Setting a place's
// default in Settings › Intelligence forgets its pick (forget): whichever was done last wins.

public struct Choice: Equatable, Sendable, Hashable {
    public var provider: String, model: String, effort: String
    public init(provider: String, model: String, effort: String) { self.provider = provider; self.model = model; self.effort = effort }
}

public enum Choices {
    public static let file = "model-choices.json"
    public static let places = ["bart", "build", "quick"]
    static let keyRE = JSRegex("^[a-z][a-z0-9]{0,23}$")
    public static let about = "The model and effort last picked by hand for @bart, Build and a sticky's quick task: where the next one starts. Written by Engelbart whenever you pick, and cleared for a place when you set its default in Settings; the lists and the defaults themselves are in model-effort-inline-question.json."

    static func text(_ v: OJ?) -> String {
        switch v { case .string(let s)?: return s; case .number(let n)?: return n == 0 ? "" : jsNumber(n); case .bool(true)?: return "true"; default: return "" }
    }

    /// A pick as it may be kept: plain keys and a known effort, or nil.
    public static func clean(_ value: OJ?) -> Choice? {
        guard let value, value.isObject else { return nil }
        let provider = text(value["provider"]).lowercased(), model = text(value["model"]).lowercased(), effort = text(value["effort"]).lowercased()
        guard keyRE.test(provider), keyRE.test(model), Question.efforts.contains(effort) else { return nil }
        return Choice(provider: provider, model: model, effort: effort)
    }

    public static func clean(provider: String, model: String, effort: String) -> Choice? {
        clean(["provider": .string(provider), "model": .string(model), "effort": .string(effort)])
    }

    /// What the file holds that is well formed, by place.
    public static func read(home: URL) -> [String: Choice] {
        let held = OJ.read(home.appendingPathComponent(file))
        var out: [String: Choice] = [:]
        for place in places { if let c = clean(held?[place]) { out[place] = c } }
        return out
    }

    /// The file written whole, over a temporary (a reader never sees half of it).
    /// `order`: the places in the order the file gets them (`{ about, ...now, [place]: pick }`: a new place goes last).
    static func write(home: URL, _ choices: [String: Choice], order: [String] = places) throws {
        var pairs: [(String, OJ)] = [("about", .string(about))]
        for place in order { if let c = choices[place] { pairs.append((place, ["provider": .string(c.provider), "model": .string(c.model), "effort": .string(c.effort)])) } }
        try writeJSONFile(home.appendingPathComponent(file), .object(pairs))
    }

    /// Keeps `choice` as where `place` starts next time. → the pick kept, or nil when it was not one (nothing is written).
    @discardableResult
    public static func remember(home: URL, place: String, _ choice: Choice?) -> Choice? {
        guard places.contains(place), let c = choice.flatMap({ clean(provider: $0.provider, model: $0.model, effort: $0.effort) }) else { return nil }
        var now = read(home: home)
        if now[place] == c { return c }
        var order = places.filter { now[$0] != nil }
        if !order.contains(place) { order.append(place) }
        now[place] = c
        try? write(home: home, now, order: order)
        return c
    }

    /// Forgets what `place` last picked. → whether there was a pick (nothing is written when not).
    @discardableResult
    public static func forget(home: URL, place: String) -> Bool {
        guard places.contains(place) else { return false }
        var now = read(home: home)
        guard now[place] != nil else { return false }
        now[place] = nil
        try? write(home: home, now)
        return true
    }
}
