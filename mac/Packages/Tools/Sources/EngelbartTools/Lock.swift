import Foundation

// One readers–writer lock per tool (src/main/tools/lock.cjs, 2026-09-23; design D14). Runs of a program (@bart turns,
// summaries, Build) share it; installing or updating that program takes it alone, after the runs in progress end, and
// runs asked for meanwhile wait for the update. A waiting update goes first, so a steady stream of questions cannot hold
// it off for ever. Safe from any thread (runs come from anywhere; the manager is on the main actor).

public final class ToolLock: @unchecked Sendable {
    private let mutex = NSLock()
    private var readers = 0
    private var writing = false
    private var writers: [CheckedContinuation<Void, Never>] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []

    public init() {}

    /// Wakes whoever may go now. Called with the mutex held; returns the continuations to resume after unlocking.
    private func wake() -> [CheckedContinuation<Void, Never>] {
        if writing { return [] }
        if !writers.isEmpty {
            if readers == 0 { writing = true; return [writers.removeFirst()] }
            return []
        }
        let go = waiting
        readers += go.count
        waiting = []
        return go
    }

    func acquireShared() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            mutex.lock()
            if !writing && writers.isEmpty { readers += 1; mutex.unlock(); c.resume() }
            else { waiting.append(c); mutex.unlock() }
        }
    }

    func releaseShared() {
        mutex.lock(); readers -= 1; let go = wake(); mutex.unlock()
        go.forEach { $0.resume() }
    }

    func acquireExclusive() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            mutex.lock()
            if !writing && readers == 0 { writing = true; mutex.unlock(); c.resume() }
            else { writers.append(c); mutex.unlock() }
        }
    }

    func releaseExclusive() {
        mutex.lock(); writing = false; let go = wake(); mutex.unlock()
        go.forEach { $0.resume() }
    }

    public func shared<T>(_ fn: () async throws -> T) async rethrows -> T {
        await acquireShared()
        do { let value = try await fn(); releaseShared(); return value } catch { releaseShared(); throw error }
    }

    public func exclusive<T>(_ fn: () async throws -> T) async rethrows -> T {
        await acquireExclusive()
        do { let value = try await fn(); releaseExclusive(); return value } catch { releaseExclusive(); throw error }
    }

    public struct State: Equatable { public let readers: Int; public let writing: Bool; public let waiting: Int }

    public var state: State {
        mutex.lock(); defer { mutex.unlock() }
        return State(readers: readers, writing: writing, waiting: writers.count + waiting.count)
    }
}
