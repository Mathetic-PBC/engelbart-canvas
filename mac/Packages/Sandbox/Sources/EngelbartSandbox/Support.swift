import Foundation
import EngelbartCore

/// An error that carries the plain message the Electron code threw (`new Error('…')`), plus the structured details some
/// tool errors carry (`app`, `failed_check`, `dependency_install`: local-tools.cjs's bridge answers with them).
public struct SandboxError: Error, LocalizedError, Equatable, @unchecked Sendable {
    public var message: String
    public var details: [String: JSONValue]
    /// E2B's `name` for the error, when it came from E2B (`NotFoundError`, `SandboxNotFoundError`, `TimeoutError`…).
    public var name: String?
    /// HTTP status, when an E2B REST call answered with one.
    public var status: Int?
    /// A command's exit code (E2B's CommandExitError), when it has one.
    public var exitCode: Int?

    public init(_ message: String, details: [String: JSONValue] = [:], name: String? = nil, status: Int? = nil, exitCode: Int? = nil) {
        self.message = message; self.details = details; self.name = name; self.status = status; self.exitCode = exitCode
    }
    public var errorDescription: String? { message }

    /// manager.cjs's `notFound`: E2B says the sandbox (or process) does not exist.
    public var isNotFound: Bool { name == "NotFoundError" || name == "SandboxNotFoundError" || status == 404 }
}

func message(of error: Error) -> String {
    if let e = error as? SandboxError { return e.message }
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return (error as NSError).localizedDescription
}

func isNotFound(_ error: Error) -> Bool { (error as? SandboxError)?.isNotFound == true }
func exitCodeOf(_ error: Error) -> Int? { (error as? SandboxError)?.exitCode }

/// The AbortController/AbortSignal pair the Electron code passes everywhere: aborted once, with a reason; listeners run
/// at once (or immediately when added after the abort).
public final class AbortSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var _reason: Error?
    private var listeners: [UUID: () -> Void] = [:]

    public init() {}

    public var aborted: Bool { lock.lock(); defer { lock.unlock() }; return _reason != nil }
    public var reason: Error? { lock.lock(); defer { lock.unlock() }; return _reason }

    public func abort(_ reason: Error? = nil) {
        lock.lock()
        if _reason != nil { lock.unlock(); return }
        _reason = reason ?? SandboxError("This operation was aborted", name: "AbortError")
        let run = Array(listeners.values)
        listeners = [:]
        lock.unlock()
        run.forEach { $0() }
    }

    public func throwIfAborted() throws { if let reason { throw reason } }

    @discardableResult
    public func onAbort(_ handler: @escaping () -> Void) -> UUID {
        let id = UUID()
        lock.lock()
        if _reason != nil { lock.unlock(); handler(); return id }
        listeners[id] = handler
        lock.unlock()
        return id
    }

    public func removeListener(_ id: UUID) { lock.lock(); listeners[id] = nil; lock.unlock() }

    /// `AbortSignal.any`: aborted as soon as one of them is.
    public static func any(_ signals: [AbortSignal]) -> AbortSignal {
        let combined = AbortSignal()
        for signal in signals { signal.onAbort { [weak combined, weak signal] in combined?.abort(signal?.reason) } }
        return combined
    }

    /// Sleeps `seconds`, ending early (without throwing) when aborted. → whether it was aborted.
    @discardableResult
    public func sleep(_ seconds: Double) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let once = Once()
            let id = onAbort { if once.claim() { c.resume(returning: true) } }
            DispatchQueue.global().asyncAfter(deadline: .now() + max(0, seconds)) { [weak self] in
                self?.removeListener(id)
                if once.claim() { c.resume(returning: false) }
            }
        }
    }
}

/// A flag claimed once, across threads.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

/// A value guarded by a lock.
public final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Value
    public init(_ value: Value) { _value = value }
    public var value: Value { lock.lock(); defer { lock.unlock() }; return _value }
    @discardableResult
    public func with<T>(_ body: (inout Value) throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body(&_value) }
}

/// A one-shot result many may wait for (a JS Promise made by hand: `new Promise((resolve, reject) => …)`).
public final class Deferred<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?
    private var waiters: [CheckedContinuation<Value, Error>] = []

    public init() {}

    public var isSettled: Bool { lock.lock(); defer { lock.unlock() }; return result != nil }

    public func resolve(_ value: Value) { settle(.success(value)) }
    public func reject(_ error: Error) { settle(.failure(error)) }

    public func settle(_ value: Result<Value, Error>) {
        lock.lock()
        if result != nil { lock.unlock(); return }
        result = value
        let w = waiters; waiters = []
        lock.unlock()
        for c in w { c.resume(with: value) }
    }

    public func wait() async throws -> Value {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Value, Error>) in
            lock.lock()
            if let result { lock.unlock(); c.resume(with: result); return }
            waiters.append(c)
            lock.unlock()
        }
    }

    /// Waits, never throwing: the error as a value.
    public func settled() async -> Result<Value, Error> {
        do { return .success(try await wait()) } catch { return .failure(error) }
    }
}

/// manager.cjs's `exclusive(key, action)`: actions with the same key run one after another, in call order; a failure
/// does not stop the next.
public final class KeyedQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var tails: [String: Task<Void, Never>] = [:]

    public init() {}

    public func run<T>(_ key: String, _ action: @escaping () async throws -> T) async throws -> T {
        let result = Deferred<T>()
        let task: Task<Void, Never> = lock.withLock {
            let previous = tails[key]
            let task = Task<Void, Never> {
                await previous?.value
                do { result.resolve(try await action()) } catch { result.reject(error) }
            }
            tails[key] = task
            return task
        }
        defer { lock.withLock { if tails[key] == task { tails[key] = nil } } }
        return try await result.wait()
    }

    /// Waits for everything queued now (`Promise.allSettled([...locks.values()])`).
    public func drain() async {
        let all = lock.withLock { Array(tails.values) }
        for task in all { await task.value }
    }
}

/// A serial chain (`chain = chain.then(…)`): each job starts after the previous one ended.
final class SerialChain: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Task<Void, Never>?

    func enqueue(_ job: @escaping () async -> Void) -> Task<Void, Never> {
        lock.withLock {
            let previous = tail
            let task = Task<Void, Never> { await previous?.value; await job() }
            tail = task
            return task
        }
    }

    func idle() async { let t = lock.withLock { tail }; await t?.value }
}

enum Shell {
    /// worker.cjs's `quote`: a single-quoted shell word.
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}

extension String {
    /// `text.slice(-n)`.
    func tail(_ n: Int) -> String { count > n ? String(suffix(n)) : self }
    /// `text.slice(0, n)`.
    func head(_ n: Int) -> String { count > n ? String(prefix(n)) : self }
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    func matches(_ pattern: String, options: NSRegularExpression.Options = []) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return false }
        return re.firstMatch(in: self, range: NSRange(startIndex..., in: self)) != nil
    }
    func captures(_ pattern: String, options: NSRegularExpression.Options = []) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options),
              let m = re.firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            guard r.location != NSNotFound, let range = Range(r, in: self) else { return nil }
            return String(self[range])
        }
    }
    /// UTF-8 byte length (`Buffer.byteLength`).
    var byteLength: Int { utf8.count }
}

/// Control characters as the Electron regexes name them: U+0000–U+001F and U+007F–U+009F.
func hasControlCharacters(_ text: String) -> Bool {
    text.unicodeScalars.contains { ($0.value <= 0x1f) || ($0.value >= 0x7f && $0.value <= 0x9f) }
}

func stripControlCharacters(_ text: String, replacement: String = "") -> String {
    var out = ""
    for scalar in text.unicodeScalars {
        if scalar.value <= 0x1f || (scalar.value >= 0x7f && scalar.value <= 0x9f) { out += replacement } else { out.unicodeScalars.append(scalar) }
    }
    return out
}

extension JSONValue {
    /// `JSON.stringify(value)`: compact, keys in insertion order is not available, so sorted (stable).
    var compact: String { text() }
    static func from(_ dictionary: [String: JSONValue?]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (k, v) in dictionary { if let v { out[k] = v } }
        return .object(out)
    }
    /// JavaScript truthiness, for the few places the Electron code tests `!!value`.
    var truthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }
    /// A number that is an integer (`Number.isInteger`).
    var integer: Int? { if case .number(let n) = self, n.rounded() == n, abs(n) < 9.0e15 { return Int(n) }; return nil }
}

/// Milliseconds since 1970 (`Date.now()`), the manager's injectable clock.
public typealias Clock = @Sendable () -> Double
public let systemClock: Clock = { Time.ms() }

/// The bundled Python helpers (src/main/sandbox/*.py).
public enum SandboxResources {
    public static func url(_ name: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Resources")
            ?? Bundle.module.resourceURL?.appendingPathComponent("Resources/\(name)")
    }
    public static func text(_ name: String) throws -> String {
        guard let url = url(name), let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw SandboxError("Missing sandbox helper \(name)")
        }
        return text
    }
}
