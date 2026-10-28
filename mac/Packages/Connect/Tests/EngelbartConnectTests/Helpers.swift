import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// A temporary folder removed after the test.
final class TempDir {
    let url: URL
    var path: String { url.path }
    init() {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("connect-test-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(at: url) }
    @discardableResult
    func write(_ rel: String, _ text: String) -> String {
        let file = url.appendingPathComponent(rel)
        try! FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! text.write(to: file, atomically: true, encoding: .utf8)
        return file.path
    }
    @discardableResult
    func mkdir(_ rel: String) -> String {
        let dir = url.appendingPathComponent(rel)
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }
}

/// The Store as the tests see it: rows kept in memory, Markdown copies written under the data root.
final class FakeStore: ConnectStore, @unchecked Sendable {
    let root: String
    let lock = NSLock()
    var added: [(name: String, text: String, about: JSONValue?)] = []
    var items: [(input: String, name: String?)] = []
    var kept: [String: [String]] = [:]
    init(root: String) { self.root = root }
    func dataRoot() async -> String { root }
    func rows() async -> [LibraryRow] { lock.lock(); defer { lock.unlock() }; return added.map { LibraryRow(id: IDs.new(), name: $0.name, type: "markdown", tags: ["note"]) } }
    func addMarkdownCopy(name: String, text: String, pictures: [Notes.Picture], about: JSONValue?) async throws -> LibraryRow {
        lock.lock(); added.append((name, text, about)); lock.unlock()
        return LibraryRow(id: IDs.new(), name: name, type: "markdown", tags: ["note"])
    }
    func addItem(_ input: String, name: String?, describe: Bool, about: JSONValue?) async throws -> LibraryRow {
        lock.lock(); defer { lock.unlock() }
        if items.contains(where: { $0.input == input }) { throw LibraryExists(row: LibraryRow(id: IDs.new(), name: name ?? input)) }
        items.append((input, name))
        return LibraryRow(id: IDs.new(), name: name ?? (input as NSString).lastPathComponent, type: input.hasSuffix(".pdf") ? "pdf" : "file")
    }
    func addFileCopy(bytes: Data, mime: String, name: String, url: String?, about: JSONValue?) async throws -> LibraryRow { LibraryRow(id: IDs.new(), name: name, type: "pdf") }
    func inspectPdf(_ path: String) async throws -> [String] { path.contains("paper") ? ["paper"] : [] }
    func projectDir(_ projectId: String) async -> String? { nil }
    func workspaceExists(projectId: String, workspaceId: String) async -> Bool { false }
    func saveImage(projectId: String, bytes: Data, mime: String, name: String) async throws -> String { IDs.new() }
    var notes: [(name: String, text: String)] = []
    func createNote(projectId: String, name: String, text: String) async throws -> (id: String, name: String) { lock.lock(); notes.append((name, text)); lock.unlock(); return (IDs.new(), name) }
    func keepInProject(projectId: String, rowIds: [String]) async throws -> (listed: [String], removed: [String]) { kept[projectId, default: []] += rowIds; return (rowIds, []) }
    func linkToWorkspace(projectId: String, workspaceId: String, rowIds: [String]) async throws -> [String] { rowIds }
    func projectNames() async -> [String] { [] }
}

/// A page answering scripted evaluate() calls (web-chats, gmail), for the readers' tests.
final class FakePage: AgentPage, @unchecked Sendable {
    var answers: [(String) -> JSONValue?] = []
    var current = "https://chatgpt.com/"
    var evaluated: [String] = []
    init(_ answers: [(String) -> JSONValue?]) { self.answers = answers }
    func open(_ url: String) async throws -> JSONValue { current = url; return ["url": .string(url), "title": ""] }
    func ensure(_ url: String) async throws -> JSONValue { current = url; return ["url": .string(url)] }
    func read(offset: Int, maxChars: Int) async throws -> JSONValue { ["elements": []] }
    func click(_ ref: String) async throws -> JSONValue { .null }
    func type(_ ref: String, _ text: String, submit: Bool, replace: Bool) async throws -> JSONValue { .null }
    func press(_ key: String) async throws -> JSONValue { .null }
    func scroll(ref: String, direction: String, amount: Double) async throws -> JSONValue { .null }
    func wait(seconds: Double, untilText: String, untilGone: String, stable: Bool) async throws -> JSONValue { .null }
    func screenshot() async throws -> (data: String, mimeType: String) { ("", "image/jpeg") }
    func evaluate(_ script: String) async throws -> JSONValue {
        evaluated.append(script)
        for a in answers { if let v = a(script) { return v } }
        return .null
    }
    func download(_ url: String, dir: String, name: String, maxBytes: Int?, quiet: Bool) async throws -> (path: String, bytes: Int, type: String, url: String) { throw ConnectError("failed", "no downloads") }
    func url() -> String { current }
}
