import Foundation

// What Engelbart needs of each program it runs (src/main/tools/requirements.cjs, 2026-09-23; design D7).
// Versions compare as x.y.z. `minimum` is the oldest version every command Engelbart gives it was checked on;
// `incompatible` lists ranges known not to work ({ from, to, why }, `to` excluded), none yet; `testedMajor` is the newest
// major version Engelbart ran against: a newer one is allowed and shown as untested. `version` finds the number in what
// `--version` prints, before any looser match is tried.

public struct IncompatibleRange: Sendable, Equatable {
    public let from: String
    public let to: String
    public let why: String
    public init(from: String, to: String, why: String) { self.from = from; self.to = to; self.why = why }
}

public struct Requirement: Sendable {
    public let name: String
    public let minimum: String
    public let testedMajor: Int
    public let incompatible: [IncompatibleRange]
    /// The program's own version line; group 1 is the number.
    public let version: String
    public let why: String

    public init(name: String, minimum: String, testedMajor: Int, incompatible: [IncompatibleRange], version: String, why: String) {
        self.name = name; self.minimum = minimum; self.testedMajor = testedMajor
        self.incompatible = incompatible; self.version = version; self.why = why
    }

    /// A copy with other known-bad ranges (tests).
    public func with(incompatible ranges: [IncompatibleRange]) -> Requirement {
        Requirement(name: name, minimum: minimum, testedMajor: testedMajor, incompatible: ranges, version: version, why: why)
    }
}

public enum Requirements {
    public static let git = Requirement(
        name: "Git", minimum: "2.30.0", testedMajor: 2, incompatible: [],
        version: #"git version (\d+\.\d+(?:\.\d+)?)"#,
        why: "Build uses `git worktree repair` (2.29) and reads locked worktrees from `git worktree list` (2.30).")
    public static let claude = Requirement(
        name: "Claude Code", minimum: "2.1.278", testedMajor: 2, incompatible: [],
        version: #"(\d+\.\d+\.\d+)\s*\(Claude Code\)"#,
        why: "@bart and the summaries pass --restricted, --effort max, --include-partial-messages and the fable alias, all checked on 2.1.278.")
    public static let codex = Requirement(
        name: "Codex", minimum: "0.155.0", testedMajor: 0, incompatible: [],
        version: #"codex-cli\s+(\d+\.\d+\.\d+)"#,
        why: "@bart and the summaries use exec resume, -o, --ephemeral and the ultra effort, all checked on 0.155.0.")

    /// The shipped table (immutable: `let`s of value types).
    public static let all: [String: Requirement] = ["git": git, "claude": claude, "codex": codex]

    public static subscript(name: String) -> Requirement { all[name] ?? git }
}

/// The three programs, in the order every list shows them.
public let TOOL_NAMES = ["git", "claude", "codex"]
/// The two that answer questions.
public let AGENTS = ["claude", "codex"]
/// @bart's providers are named for the company, the tools for the program.
public let PROVIDER_OF = ["claude": "anthropic", "codex": "openai"]
public let TOOL_OF = ["anthropic": "claude", "openai": "codex"]

public func requiresText(_ name: String) -> String { ">=\(Requirements[name].minimum)" }

public func isAgent(_ name: String) -> Bool { AGENTS.contains(name) }
