import Foundation
import EngelbartCore

/// What a running ask tells the window that asked (Electron's `engelbart:bart-progress`, `{ askId, ...progress }`).
public enum BartProgress: Equatable, Sendable {
    /// A step begins: `name`/`effort` are nil for @brainstorm, whose model is never named (2026-10-02, B-05).
    case step(step: Int, of: Int, name: String?, effort: String?, movedUp: Int)
    /// What it is doing; `log` when the label belongs in the box's log of steps.
    case activity(String, log: Bool)
    /// The answer so far, as lines (bodyLines), the preview held outside the document.
    case lines([String])
    /// @create's line on what it is making (making.cjs).
    case making(String)
    /// @discover's steps told as its trace (Trace).
    case trace(JSONValue)

    /// The payload as the Electron channel carried it (without askId).
    public var json: JSONValue {
        switch self {
        case .step(let step, let of, let name, let effort, let movedUp):
            var o: [String: JSONValue] = ["step": .number(Double(step)), "of": .number(Double(of)), "movedUp": .number(Double(movedUp))]
            if let name { o["name"] = .string(name) }
            if let effort { o["effort"] = .string(effort) }
            return .object(o)
        case .activity(let label, let log):
            return log ? ["activity": .string(label), "log": true] : ["activity": .string(label)]
        case .lines(let lines): return ["lines": .array(lines.map { .string($0) })]
        case .making(let line): return ["making": .string(line)]
        case .trace(let story): return ["trace": story]
        }
    }

    /// `{ askId, ...progress }`.
    public func payload(askId: String) -> JSONValue {
        var o = json.object ?? [:]
        o["askId"] = .string(askId)
        return .object(o)
    }
}

/// The Electron channel names, kept as EventHub event names.
public enum BartEvents {
    public static let progress = "engelbart:bart-progress"
    public static let paperAskDone = "engelbart:paper-ask-done"
    public static let agentRun = "engelbart:agent-run"
    public static let agentReveal = "engelbart:agent-reveal"
    public static let modelsChanged = "engelbart:models-changed"
    public static let libraryChanged = "engelbart:library-changed"
    public static let chatBenchmark = "engelbart:chat-benchmark"
}
