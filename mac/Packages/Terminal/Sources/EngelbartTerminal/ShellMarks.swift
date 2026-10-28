import Foundation

// The shell-integration marks the zsh wrappers emit (ShellRC.swift): OSC 633 with A = ready for a command, C = a
// command started, E;<line> = its command line, P;Cwd=<dir> = where the shell is. xterm.js handed them to a registered
// OSC handler (sessions.js applyShellMark); here they are picked out of the session's byte stream, across chunk
// boundaries, before the bytes reach the SwiftTerm view (which ignores OSC 633).

/// What the pane knows about a tab's shell (sessions.js `record.shell`).
public struct ShellState: Equatable, Sendable {
    public var integrated: Bool
    public var busy: Bool
    public var command: String
    public var cwd: String

    /// Before any mark: busy unless it is a plain shell (Claude Code and Codex run at once).
    public static func initial(provider: TerminalProvider, cwd: String) -> ShellState {
        ShellState(integrated: false, busy: provider != .shell, command: "", cwd: cwd)
    }

    /// One mark's payload (what follows `633;`). → whether it was a mark the pane uses.
    @discardableResult
    public mutating func apply(_ data: String) -> Bool {
        guard let kind = data.first else { return false }
        let rest = data.count > 2 ? String(data.dropFirst(2)) : ""
        switch kind {
        case "A": integrated = true; busy = false; command = ""
        case "C": integrated = true; busy = true
        case "E": command = rest
        case "P" where rest.hasPrefix("Cwd="):
            let dir = String(rest.dropFirst(4))
            if !dir.isEmpty { cwd = dir }
        default: return false
        }
        return true
    }
}

/// Finds `ESC ] 633 ; … (BEL | ESC \)` in a stream of chunks.
public struct OscScanner: Sendable {
    private enum State: Sendable { case ground, escape, osc, oscEscape }
    private var state: State = .ground
    private var payload: [UInt8] = []
    private var overflow = false
    static let maxPayload = 16 * 1024

    public init() {}

    /// The OSC 633 payloads (after `633;`) completed in this chunk, in order.
    public mutating func scan(_ bytes: [UInt8]) -> [String] {
        var marks: [String] = []
        for byte in bytes {
            switch state {
            case .ground:
                if byte == 0x1b { state = .escape }
            case .escape:
                if byte == 0x5d { state = .osc; payload.removeAll(keepingCapacity: true); overflow = false }
                else if byte == 0x1b { state = .escape }
                else { state = .ground }
            case .osc:
                if byte == 0x07 { finish(&marks) }
                else if byte == 0x1b { state = .oscEscape }
                else if byte == 0x18 || byte == 0x1a { state = .ground } // CAN / SUB abort a sequence
                else if payload.count < Self.maxPayload { payload.append(byte) } else { overflow = true }
            case .oscEscape:
                if byte == 0x5c { finish(&marks) }
                else if byte == 0x5d { state = .osc; payload.removeAll(keepingCapacity: true); overflow = false }
                else { state = .ground }
            }
        }
        return marks
    }

    private mutating func finish(_ marks: inout [String]) {
        state = .ground
        guard !overflow else { return }
        let prefix: [UInt8] = Array("633;".utf8)
        if payload.count >= prefix.count && Array(payload[0..<prefix.count]) == prefix {
            marks.append(String(decoding: payload[prefix.count...], as: UTF8.self))
        }
    }
}

/// What a tab is right now: a plain terminal, or an agent (by dropdown launch or by typing its name). TerminalPane.jsx
/// `describe`.
public struct TabDescription: Equatable, Sendable {
    public var integrated: Bool
    public var busy: Bool
    /// "shell", "claude", "codex" or "sandbox".
    public var agent: String
    public var command: String
    public var cwd: String?

    public static func of(provider: TerminalProvider, shell: ShellState) -> TabDescription {
        let integrated = shell.integrated
        let busy = integrated ? shell.busy : provider != .shell
        let agent = integrated ? (busy ? (agentOfCommand(shell.command) ?? "shell") : "shell") : provider.rawValue
        return TabDescription(integrated: integrated, busy: busy, agent: agent, command: shell.command, cwd: integrated && !shell.cwd.isEmpty ? shell.cwd : nil)
    }

    static let agentCommand = try! NSRegularExpression(
        pattern: #"^(?:\s*(?:command|exec|noglob|nocorrect|sudo)\s+|\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\s*(?:\S*/)?(claude|codex)(?:\s|$)"#)

    /// `claude` or `codex` when the command line starts one (after command/exec/noglob/nocorrect/sudo or VAR=value,
    /// by any path); else nil.
    public static func agentOfCommand(_ command: String) -> String? {
        let range = NSRange(command.startIndex..., in: command)
        guard let match = agentCommand.firstMatch(in: command, range: range), let group = Range(match.range(at: 1), in: command) else { return nil }
        return String(command[group])
    }
}
