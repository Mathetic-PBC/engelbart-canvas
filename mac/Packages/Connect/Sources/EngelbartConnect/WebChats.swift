import Foundation
import EngelbartCore

// Port of src/main/connect/web-chats.cjs (Connect your library, 2026-10-07, second build): ChatGPT's and Claude's chats
// read from the person's own signed-in page, so neither export is needed. A script runs in the agent's hidden browser on
// chatgpt.com or claude.ai (AgentPage.evaluate) and asks the site for what its own page asks it for: the conversation list
// and one conversation, as JSON. Those are the shapes the exports hold, so Readers.exportChat reads them into turns.
// Whether the account is signed in is told only by an answer that says so; anything else is asked once more 3 s later.
public enum WebChats {
    public static let apps = ["ChatGPT", "Claude"]
    public static let starts = ["ChatGPT": "https://chatgpt.com/", "Claude": "https://claude.ai/recents"]
    static let idRE = #"^[\w-]{6,80}$"#
    public static let maxList = 2000
    static let retryMs = 3000.0

    static func fill(_ template: String, id: String? = nil, limit: Int? = nil) -> String {
        var s = template
        if let limit { s = s.replacingOccurrences(of: "__LIMIT__", with: String(limit)) }
        if let id { s = s.replacingOccurrences(of: "\"__ID__\"", with: JSONValue.string(id).text()) }
        return s
    }
    static func listScript(_ app: String) -> String { fill(app == "ChatGPT" ? Texts.chatgptList : Texts.claudeList, limit: maxList) }
    static func oneScript(_ app: String, _ id: String) -> String { fill(app == "ChatGPT" ? Texts.chatgptOne : Texts.claudeOne, id: id) }
    static func deleteScript(_ app: String, _ id: String) -> String { fill(app == "ChatGPT" ? Texts.chatgptDelete : Texts.claudeDelete, id: id) }

    static func check(_ app: String) throws {
        guard starts[app] != nil else { throw ConnectError("failed", "app must be one of \(apps.joined(separator: ", "))") }
    }
    static func signedOut(_ app: String) -> ConnectError {
        ConnectError("signed-out", "Not signed in to \(app) in Engelbart's browser. Call needs_you with kind \"signin\", then try again.")
    }

    /// The script's answer, asked once more after a pause when it couldn't tell whether the account is signed in.
    static func ask(_ page: AgentPage, _ app: String, _ script: String, sleep: (Double) async -> Void) async throws -> JSONValue {
        var out = try await page.evaluate(script)
        if out["signedIn"] == .bool(false) { throw signedOut(app) }
        if out.isNull || out["signedIn"] == nil || out["signedIn"]!.isNull {
            await sleep(retryMs)
            out = try await page.evaluate(script)
            if out["signedIn"] == .bool(false) { throw signedOut(app) }
            if !JS.truthy(out["signedIn"]) {
                let status = JS.truthy(out["status"]) ? " (it answered \(JS.string(out["status"])))" : ""
                throw ConnectError("unsure", "\(app) didn't say whether you're signed in\(status), twice. This is not a sign-out: reload the page and try again, or read the page itself.")
            }
        }
        return out
    }

    static func timeOf(_ value: JSONValue?) -> Double {
        if let n = value?.double { return n < 1e12 ? n * 1000 : n }
        if let s = value?.string { return Time.parse(s).map { Time.ms($0) } ?? 0 }
        return 0
    }

    /// The chats of a signed-in account, newest first → { account, total, chats: [{ id, title, date, project }], partial? }.
    public static func list(_ page: AgentPage, _ app: String, days: Double? = nil, query: String = "", project: String = "", limit: Double = 200,
                            sleep: @escaping (Double) async -> Void = { await waitFor($0) }, now: Date = Date()) async throws -> JSONValue {
        try check(app)
        _ = try await page.ensure(starts[app]!)
        let out = try await ask(page, app, listScript(app), sleep: sleep)
        let items = out["items"]?.array ?? []
        if JS.truthy(out["error"]) && items.isEmpty { throw ConnectError("failed", "\(JS.string(out["error"])). Fall back to reading the page.") }
        let since = (days.map { $0.isFinite && $0 > 0 } ?? false) ? Time.ms(now) - days! * 86_400_000 : 0
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let wanted = project.lowercased()
        var rows: [(id: String, title: String, date: String?, project: String?)] = []
        for item in items {
            let id = JS.string(item["id"])
            guard JS.test(id, idRE) else { continue }
            let updated = timeOf(JS.truthy(item["updated"]) ? item["updated"] : item["created"])
            if since > 0 && updated > 0 && updated < since { continue }
            let title = Cursor.clip(JS.truthy(item["title"]) ? JS.string(item["title"]) : "Untitled", 160)
            let proj = JS.truthy(item["project"]) ? Cursor.clip(JS.string(item["project"]), 80) : nil
            if !words.isEmpty && !words.allSatisfy({ "\(title) \(proj ?? "")".lowercased().contains($0) }) { continue }
            if !wanted.isEmpty && !(proj ?? "").lowercased().contains(wanted) { continue }
            rows.append((id, title, updated > 0 ? Time.iso(Date(timeIntervalSince1970: updated / 1000)) : nil, proj))
        }
        rows.sort { ($0.date ?? "null") > ($1.date ?? "null") }
        let cap = min(max(1, limit.isFinite && limit.rounded() != 0 ? Int(limit.rounded()) : 200), maxList)
        var o: [String: JSONValue] = ["account": .string(JS.string(out["account"])), "total": .number(Double(items.count)),
                                      "chats": .array(rows.prefix(cap).map { ["id": .string($0.id), "title": .string($0.title), "date": $0.date.map { .string($0) } ?? .null, "project": $0.project.map { .string($0) } ?? .null] })]
        if JS.truthy(out["partial"]) { o["partial"] = out["partial"] }
        return .object(o)
    }

    public struct Chat: Sendable { public var id: String; public var title: String; public var date: String?; public var project: String?; public var turns: [Readers.Turn] }

    /// One conversation read into turns.
    public static func read(_ page: AgentPage, _ app: String, _ id: String, sleep: @escaping (Double) async -> Void = { await waitFor($0) }) async throws -> Chat {
        try check(app)
        guard JS.test(id, idRE) else { throw ConnectError("failed", "Not a conversation id") }
        _ = try await page.ensure(starts[app]!)
        let out = try await ask(page, app, oneScript(app, id), sleep: sleep)
        guard !JS.truthy(out["error"]), let conversation = out["conversation"], JS.truthy(conversation) else {
            throw ConnectError("failed", JS.truthy(out["error"]) ? JS.string(out["error"]) : "\(app) sent no conversation")
        }
        var merged = conversation.object ?? [:]
        if app == "ChatGPT" { merged["conversation_id"] = merged["conversation_id"] ?? .string(id); if merged["conversation_id"] == nil { merged["conversation_id"] = .string(id) } }
        else { if merged["uuid"] == nil { merged["uuid"] = .string(id) } }
        // { conversation_id: id, ...conversation } / { uuid: id, ...conversation }: the conversation's own fields win.
        guard let chat = Readers.exportChat(.object(merged)) else { throw ConnectError("failed", "\(app)'s conversation could not be read") }
        let title = !chat.title.isEmpty ? chat.title : (!Cursor.clip(chat.turns.first?.text, 80).isEmpty ? Cursor.clip(chat.turns.first?.text, 80) : "\(app) chat")
        return Chat(id: id, title: title, date: chat.updated > 0 ? Time.iso(Date(timeIntervalSince1970: chat.updated / 1000)) : nil, project: nil, turns: chat.turns)
    }

    /// The chat a ChatGPT or Claude address shows → its id, or nil.
    public static func chatIdOf(_ app: String, _ url: String) -> String? {
        let pattern = app == "ChatGPT" ? #"^https://chatgpt\.com/(?:g/[\w-]+/)?c/([\w-]{6,80})(?:[/?#]|$)"# : app == "Claude" ? #"^https://claude\.ai/chat/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)"# : nil
        guard let pattern else { return nil }
        return JS.match(url, pattern, options: app == "Claude" ? .caseInsensitive : [])?[1] ?? nil
    }

    static func squash(_ text: String) -> String { JS.replace(text, #"\s+"#, " ").trimmingCharacters(in: .whitespaces) }

    /// Deletes the one chat Engelbart opened to ask its memory question, only when its first message is the question.
    @discardableResult
    public static func delete(_ page: AgentPage, _ app: String, _ id: String, question: String, sleep: @escaping (Double) async -> Void = { await waitFor($0) }) async throws -> JSONValue {
        try check(app)
        guard JS.test(id, idRE) else { throw ConnectError("failed", "Not a conversation id") }
        let chat = try await read(page, app, id, sleep: sleep)
        let first = chat.turns.first { $0.role == "user" }
        let opening = String(squash(question).prefix(80))
        guard !opening.isEmpty, let first, squash(first.text).hasPrefix(opening) else { throw ConnectError("failed", "that chat is not the question Engelbart sent, so it was left as it is") }
        let out = try await ask(page, app, deleteScript(app, id), sleep: sleep)
        if JS.truthy(out["error"]) || !JS.truthy(out["deleted"]) { throw ConnectError("failed", JS.truthy(out["error"]) ? JS.string(out["error"]) : "\(app) did not delete it") }
        return ["deleted": true]
    }
}
