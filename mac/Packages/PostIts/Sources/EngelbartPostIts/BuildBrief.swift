import Foundation
import EngelbartCore

/// What a card knows of its latest quick task (views.cjs briefBuild): { id, status, final, kind, workspace }, the
/// workspace being the name of the one it was added to (a task that became a Build of a workspace).
public struct BuildBrief: Equatable, Sendable {
    public var id: String
    public var status: String
    public var final: Bool
    public var kind: String
    public var workspace: String?
    public init(id: String, status: String, final: Bool = false, kind: String = "quick", workspace: String? = nil) {
        self.id = id; self.status = status; self.final = final; self.kind = kind; self.workspace = workspace
    }

    static let working: Set<String> = ["setting-up", "queued", "running", "accepting"]

    /// A Build under way (Building and its dots).
    public var isWorking: Bool { BuildBrief.working.contains(status) }
    /// Added to a workspace: the card shows that workspace's name, and a click goes there.
    public var moved: Bool { kind == "build" && (workspace?.isEmpty == false) }
    /// The state on a card (Card.jsx, Claude Design "Post-it Quick Task", 2026-09-27): '' for none or discarded.
    public var word: String {
        if status == "discarded" { return "" }
        if moved { return workspace ?? "" }
        if status == "accepted" { return "Merged" }
        if isWorking { return "Building" }
        if status == "stopped" || status == "interrupted" { return "Stopped" }
        return "Needs you"
    }
    /// Ink rather than the footer's brown: a state that asks for attention.
    public var strong: Bool { !(BuildBrief.idle(self) || moved) }
    /// A merged one says so and its button cannot be pressed (nothing to open).
    public var disabled: Bool { status == "accepted" && !moved }

    /// No task, a discarded one, or one merged without moving: Build is offered again.
    public static func idle(_ brief: BuildBrief?) -> Bool {
        guard let brief else { return true }
        return brief.status == "discarded" || (brief.status == "accepted" && !brief.moved)
    }
}

/// The quick task's card (post-its/PostItTask.jsx): its word, what it is doing and what it says once it stopped short.
public enum QuickTaskText {
    public static let TOO_BIG = "This task was too complex to build outside of a project. You must add it to a project below to continue."
    public static let STOPPED = "This task was stopped. Add it to a project below to continue."

    public static func working(_ status: String) -> Bool { BuildBrief.working.contains(status) }

    public static func word(_ status: String) -> String {
        working(status) ? "Building" : (status == "stopped" || status == "interrupted") ? "Stopped" : "Needs you"
    }

    /// What its turn is doing (the progress event's activity), else what its status says.
    public static func activity(status: String, progress: String?) -> String {
        if let progress, !progress.isEmpty { return progress }
        return status == "setting-up" ? "Setting up its copy of the code" : status == "queued" ? "Waiting for a slot" : "Working"
    }

    /// What the card says a task that stopped short needs.
    public static func message(status: String, error: String?) -> String {
        if status == "stopped" || status == "interrupted" { return STOPPED }
        if status == "failed" {
            var tail = ""
            if let error, !error.isEmpty { tail = ": " + (error.hasSuffix(".") ? String(error.dropLast()) : error) }
            return "This task failed\(tail). Add it to a workspace below to continue."
        }
        if status == "review" || status == "conflict" { return "This task's changes could not be merged on their own. Add it to a project below to review them." }
        return TOO_BIG
    }
}
