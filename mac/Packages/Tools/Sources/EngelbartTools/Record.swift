import EngelbartCore
import Foundation

// config.json → `tools` (src/main/tools/record.cjs, 2026-09-23; design D5): what the last check saw of Git, Claude Code
// and Codex, and the person's own choices about them. Observed fields are rewritten by every check and never trusted
// between checks; `requires` always comes from Requirements; `skip`, `pin` and `tools.updates` belong to the person.

public let STATUSES = ["unknown", "checking", "ready", "missing", "outdated", "incompatible", "signed-out", "installing", "updating", "signing-in", "failed"]
/// Where a program came from, which decides how it is updated and whether an update can be undone. `bundled`: the Git
/// that came with Engelbart (BundledGit.swift), updated with the app; `desktop`: the Claude app's own Claude Code.
public let SOURCES = ["apple", "homebrew", "bundled", "native", "standalone", "npm", "bun", "desktop", "other"]
public let UPDATES = ["auto", "ask"]
let MAX_ERROR = 300

/// A loose record, as the Electron code kept them (`{ ...seen, ...pick(found) }` needs key presence, not just values).
public typealias Fields = [String: JSONValue]

public struct FailedUpdate: Equatable, Sendable {
    public var from: String
    public var at: String
    public init(from: String, at: String) { self.from = from; self.at = at }
}

/// One tool's record, normalized. `signedIn` and `account` exist only for Claude Code and Codex.
public struct ToolRecord: Equatable, Sendable {
    public let name: String
    public var installed = false
    public var version: String?
    public var requires: String
    public var status = "unknown"
    public var signedIn: Bool?
    public var account: String?
    public var path: String?
    public var onPath: Bool?
    public var source: String?
    public var untested = false
    public var updaterOff = false
    public var checkedAt: String?
    public var error: String?
    public var note: String?
    public var failedUpdate: FailedUpdate?
    public var skip = false
    public var pin: String?

    public init(blank name: String) {
        self.name = name
        self.requires = requiresText(name)
    }

    /// The record as config.json holds it.
    public var json: JSONValue { .object(fields) }

    public var fields: Fields {
        var out: Fields = [
            "installed": .bool(installed),
            "version": version.map(JSONValue.string) ?? .null,
            "requires": .string(requires),
            "status": .string(status),
            "path": path.map(JSONValue.string) ?? .null,
            "onPath": onPath.map(JSONValue.bool) ?? .null,
            "source": source.map(JSONValue.string) ?? .null,
            "untested": .bool(untested),
            "updaterOff": .bool(updaterOff),
            "checkedAt": checkedAt.map(JSONValue.string) ?? .null,
            "error": error.map(JSONValue.string) ?? .null,
            "note": note.map(JSONValue.string) ?? .null,
            "failedUpdate": failedUpdate.map { ["from": .string($0.from), "at": .string($0.at)] } ?? .null,
            "skip": .bool(skip),
            "pin": pin.map(JSONValue.string) ?? .null,
        ]
        if isAgent(name) {
            out["signedIn"] = signedIn.map(JSONValue.bool) ?? .null
            out["account"] = account.map(JSONValue.string) ?? .null
        }
        return out
    }
}

/// config.json → tools as a whole.
public struct ToolsRecord: Equatable, Sendable {
    public var updates: String
    public var tools: [String: ToolRecord]

    public subscript(name: String) -> ToolRecord { tools[name] ?? ToolRecord(blank: name) }

    public var json: JSONValue {
        var out: Fields = ["updates": .string(updates)]
        for name in TOOL_NAMES { out[name] = self[name].json }
        return .object(out)
    }
}

private let ACCOUNT_RE = Rx(#"^\S{1,254}$"#)
private let SPACES = Rx(#"\s+"#)

/// One line, trimmed, at most 300 characters, or nil.
func oneLine(_ value: JSONValue?) -> String? {
    guard let text = value?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return SPACES.replace(text, with: " ").trimmingCharacters(in: .whitespaces).prefixChars(MAX_ERROR)
}

/// `Date.parse` accepting what Electron writes (`toISOString()`), and the plainer ISO forms.
func isDateText(_ text: String) -> Bool {
    if Time.parse(text) != nil { return true }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    for format in ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSS", "EEE, dd MMM yyyy HH:mm:ss zzz"] {
        f.dateFormat = format
        if f.date(from: text) != nil { return true }
    }
    return false
}

func isoTime(_ value: JSONValue?) -> String? {
    guard let text = value?.string, text.count <= 40, isDateText(text) else { return nil }
    return text
}

public func isAccount(_ text: String?) -> Bool {
    guard let text else { return false }
    return ACCOUNT_RE.test(text)
}

public func normalizeTool(_ name: String, _ value: JSONValue?) -> ToolRecord {
    let input = value?.object ?? [:]
    var out = ToolRecord(blank: name)
    if let b = input["installed"]?.bool { out.installed = b }
    if let v = input["version"]?.string, isVersion(v) { out.version = v }
    if let s = input["status"]?.string, STATUSES.contains(s) { out.status = s }
    if isAgent(name), let b = input["signedIn"]?.bool { out.signedIn = b }
    // Who is signed in (an email address, Detect.swift), only while signed in.
    if isAgent(name), out.signedIn == true, let a = input["account"]?.string, isAccount(a) { out.account = a }
    if let p = input["path"]?.string, p.count <= 4096, p.hasPrefix("/"), !p.contains("\0") { out.path = p }
    if let b = input["onPath"]?.bool { out.onPath = b }
    if let s = input["source"]?.string, SOURCES.contains(s) { out.source = s }
    out.untested = input["untested"]?.bool == true
    out.updaterOff = input["updaterOff"]?.bool == true
    out.checkedAt = isoTime(input["checkedAt"])
    out.error = oneLine(input["error"])
    out.note = oneLine(input["note"])
    if let failed = input["failedUpdate"]?.object, let from = failed["from"]?.string, isVersion(from), let at = isoTime(failed["at"]) {
        out.failedUpdate = FailedUpdate(from: from, at: at)
    }
    out.skip = input["skip"]?.bool == true
    if let pin = input["pin"]?.string, isVersion(pin) { out.pin = pin }
    return out
}

public func normalizeTools(_ value: JSONValue?) -> ToolsRecord {
    let input = value?.object ?? [:]
    let updates = input["updates"]?.string.flatMap { UPDATES.contains($0) ? $0 : nil } ?? "auto"
    var tools: [String: ToolRecord] = [:]
    for name in TOOL_NAMES { tools[name] = normalizeTool(name, input[name]) }
    return ToolsRecord(updates: updates, tools: tools)
}
