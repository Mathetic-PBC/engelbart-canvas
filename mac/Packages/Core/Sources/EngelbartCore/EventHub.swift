import Foundation

/// The app-wide announcement bus: the Swift counterpart of the Electron main → renderer channels
/// (`engelbart:library-changed`, `engelbart:bart-progress`, `post-its:hidden`, …) and of the cross-window
/// announcements in `windows.cjs`. Keep the Electron channel names as event names so the two code bases read alike.
/// Handlers run on the main queue.
public final class EventHub: @unchecked Sendable {
    public static let shared = EventHub()

    public struct Token: Hashable, Sendable { let id: UUID }

    private let lock = NSLock()
    private var handlers: [String: [UUID: (JSONValue) -> Void]] = [:]

    public init() {}

    @discardableResult
    public func on(_ name: String, _ handler: @escaping (JSONValue) -> Void) -> Token {
        let id = UUID()
        lock.lock(); handlers[name, default: [:]][id] = handler; lock.unlock()
        return Token(id: id)
    }

    public func off(_ token: Token) {
        lock.lock()
        for key in handlers.keys { handlers[key]?[token.id] = nil }
        lock.unlock()
    }

    public func post(_ name: String, _ payload: JSONValue = .null) {
        lock.lock(); let targets = Array((handlers[name] ?? [:]).values); lock.unlock()
        guard !targets.isEmpty else { return }
        if Thread.isMainThread { targets.forEach { $0(payload) } }
        else { DispatchQueue.main.async { targets.forEach { $0(payload) } } }
    }
}
