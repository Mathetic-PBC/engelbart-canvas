import Foundation

/// Phase timings of the paper's main-thread work, for the stall probe (PaperViewTests): off unless a test turns it on.
enum PaperTrace {
    nonisolated(unsafe) static var on = false
    nonisolated(unsafe) static var entries: [(name: String, start: Double, ms: Double)] = []

    static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    @inline(__always)
    static func measure<T>(_ name: @autoclosure () -> String, _ work: () throws -> T) rethrows -> T {
        guard on else { return try work() }
        let t0 = now()
        defer { entries.append((name(), t0, (now() - t0) * 1000)) }
        return try work()
    }
}
