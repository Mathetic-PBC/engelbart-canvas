import Foundation

// Version numbers as the three programs print them, and whether one is good enough (src/main/tools/version.cjs; D7).

private let LOOSE = Rx(#"(?:^|[^\d.])(\d+)\.(\d+)(?:\.(\d+))?(?![\d.]*\d)"#)
private let VERSION_RE = Rx(#"^\d+\.\d+\.\d+$"#)
private var ownPatterns: [String: Rx] = [:]
private let ownLock = NSLock()

private func ownPattern(_ name: String) -> Rx? {
    guard let requirement = Requirements.all[name] else { return nil }
    ownLock.lock(); defer { ownLock.unlock() }
    if let rx = ownPatterns[name] { return rx }
    let rx = Rx(requirement.version)
    ownPatterns[name] = rx
    return rx
}

/// "x.y.z" from what `--version` printed (the program's own pattern first, then any number that looks like one), or nil.
public func parseVersion(_ text: String?, _ name: String? = nil) -> String? {
    let output = text ?? ""
    let own = name.flatMap(ownPattern)?.exec(output)
    let found = own.map { LOOSE.exec(" \($0[1] ?? "")") } ?? LOOSE.exec(output)
    guard let found, let a = found[1].flatMap({ Int($0) }), let b = found[2].flatMap({ Int($0) }) else { return nil }
    let c = found[3].flatMap { Int($0) } ?? 0
    return "\(a).\(b).\(c)"
}

public func isVersion(_ value: String?) -> Bool {
    guard let value else { return false }
    return VERSION_RE.test(value)
}

/// -1, 0 or 1, comparing x.y.z numerically.
public func compareVersions(_ a: String, _ b: String) -> Int {
    let left = a.split(separator: ".").map { Int($0) ?? 0 }
    let right = b.split(separator: ".").map { Int($0) ?? 0 }
    for index in 0..<3 {
        let l = index < left.count ? left[index] : 0
        let r = index < right.count ? right[index] : 0
        if l != r { return l < r ? -1 : 1 }
    }
    return 0
}

public struct Verdict: Equatable, Sendable {
    /// ready | outdated | incompatible | unknown
    public var status: String
    public var untested: Bool
    public var why: String?
}

/// How a version stands against a tool's requirement. "unknown" when the version could not be read: nothing can be said,
/// so nothing is updated either.
public func judge(_ name: String, _ version: String?, _ requirement: Requirement? = nil) -> Verdict {
    let requirement = requirement ?? Requirements[name]
    guard let version, isVersion(version) else { return Verdict(status: "unknown", untested: false, why: nil) }
    if compareVersions(version, requirement.minimum) < 0 {
        return Verdict(status: "outdated", untested: false, why: "\(requirement.name) \(version) is older than \(requirement.minimum).")
    }
    if let bad = requirement.incompatible.first(where: { compareVersions(version, $0.from) >= 0 && compareVersions(version, $0.to) < 0 }) {
        return Verdict(status: "incompatible", untested: false, why: bad.why)
    }
    let major = Int(version.split(separator: ".")[0]) ?? 0
    return Verdict(status: "ready", untested: major > requirement.testedMajor, why: nil)
}
