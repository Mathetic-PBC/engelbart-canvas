import Foundation
import EngelbartCore

// Port of src/main/connect/folder-access.cjs (MATH-110, 2026-10-11): macOS's folder access, asked for once, all together
// and explained, instead of prompts popping up mid-run. macOS asks the first time a program reads inside a protected folder
// (Desktop, Documents, Downloads, iCloud Drive and the drives under ~/Library/CloudStorage).
//   protectedFolders  the protected folders on this Mac (those that exist), with the names the panel shows
//   needed(choices)   those a run with these choices would read, not asked about before
//   ask(ids)          reads each one in turn so macOS shows its prompts one after another; the answers go to
//                     <dataRoot>/.connect/folders.json, and a folder answered once is never asked about again
//   guard(...)        readable(dir): false inside a protected folder that was not allowed, unless inside a folder the
//                     person picked themselves
// Nothing here reads inside a protected folder except ask().
public enum FolderAccess {
    public static let icloud = "Library/Mobile Documents/com~apple~CloudDocs"
    public static let cloud = "Library/CloudStorage"
    public static let file = "folders.json"

    public struct Folder: Sendable, Equatable { public var id: String; public var path: String; public var name: String; public var covers: String }

    static func inside(_ dir: String, _ folder: String) -> Bool { dir == folder || dir.hasPrefix(folder + "/") }
    static func isDir(_ path: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: path, isDirectory: &d) && d.boolValue }
    static func join(_ a: String, _ b: String) -> String { (a as NSString).appendingPathComponent(b) }
    static func resolve(_ p: String) -> String { (p as NSString).standardizingPath }

    /// A drive's shown name from its folder under ~/Library/CloudStorage ("GoogleDrive-me@x.com" → "Google Drive").
    public static func driveName(_ name: String) -> String {
        if JS.test(name, "^GoogleDrive", options: .caseInsensitive) { return "Google Drive" }
        if JS.test(name, "^Dropbox", options: .caseInsensitive) { return "Dropbox" }
        if JS.test(name, "^OneDrive", options: .caseInsensitive) { return "OneDrive" }
        if JS.test(name, "^Box", options: .caseInsensitive) { return "Box" }
        let head = name.components(separatedBy: "-")[0]
        return head.isEmpty ? name : head
    }

    /// The protected folders on this Mac that exist.
    public static func protectedFolders(homeDir: String) -> [Folder] {
        var out: [Folder] = []
        for (id, name) in [("Desktop", "Desktop"), ("Documents", "Documents"), ("Downloads", "Downloads"), (icloud, "iCloud Drive")] {
            let full = join(homeDir, id)
            if isDir(full) { out.append(Folder(id: id, path: full, name: name, covers: id == icloud ? join(homeDir, "Library/Mobile Documents") : full)) }
        }
        let drives = ((try? FileManager.default.contentsOfDirectory(atPath: join(homeDir, cloud))) ?? []).filter { !$0.hasPrefix(".") }.sorted()
        let named = drives.map { ($0, driveName($0)) }
        for (name, shown) in named {
            let full = join(join(homeDir, cloud), name)
            if !isDir(full) { continue }
            // Two accounts of one drive are told apart by the account.
            let twin = named.filter { $0.1 == shown }.count > 1
            let account = name.contains("-") ? String(name[name.index(after: name.firstIndex(of: "-")!)...]) : name
            out.append(Folder(id: join(cloud, name), path: full, name: twin ? "\(shown) (\(account))" : shown, covers: full))
        }
        return out
    }

    /// What folders.json says: [id: 'allowed' | 'denied'].
    public static func readAnswers(dataRoot: URL?) -> [String: String] {
        guard let dataRoot, let saved = Files.readJSON(dataRoot.appendingPathComponent(".connect/\(file)")) else { return [:] }
        var out: [String: String] = [:]
        for (id, entry) in saved["asked"]?.object ?? [:] {
            let answer = entry.object != nil ? entry["answer"]?.string : entry.string
            if answer == "allowed" || answer == "denied" { out[id] = answer }
        }
        return out
    }

    public static func writeAnswers(dataRoot: URL?, _ answers: [String: String], now: Date = Date()) {
        guard let dataRoot else { return }
        let url = dataRoot.appendingPathComponent(".connect/\(file)")
        var asked = Files.readJSON(url)?["asked"]?.object ?? [:]
        let at = Time.iso(now)
        for (id, answer) in answers { asked[id] = ["answer": .string(answer), "at": .string(at)] }
        try? Files.writeJSON(["asked": .object(asked)], to: url)
    }

    /// Who may be read (folder-access.cjs guard).
    public struct Guard: Sendable {
        public var allowed: [Folder]
        public var blocked: [Folder]
        public var answers: [String: String]
        let homeDir: String
        let guarded: [String]
        let free: [String]

        public func readable(_ dir: String?) -> Bool {
            guard let dir, !dir.isEmpty else { return false }
            let full = FolderAccess.resolve(dir)
            if free.contains(where: { FolderAccess.inside(full, $0) }) { return true }
            // ~/Library/CloudStorage itself only lists the drives.
            if full == FolderAccess.join(homeDir, FolderAccess.cloud) { return true }
            return !guarded.contains { FolderAccess.inside(full, $0) }
        }

        /// offthread.cjs accessSpec: what the scanner needs to make the guard again.
        public var spec: JSONValue { ["answers": .object(answers.mapValues { .string($0) })] }
    }

    public static func guardFor(homeDir: String, dataRoot: URL? = nil, answers: [String: String]? = nil, picked: [String] = []) -> Guard {
        let said = answers ?? readAnswers(dataRoot: dataRoot)
        let all = protectedFolders(homeDir: homeDir)
        let allowed = all.filter { said[$0.id] == "allowed" }
        let blocked = all.filter { said[$0.id] != "allowed" }
        // A drive that is not there yet, or one this list missed, is guarded all the same.
        let mobile = "Library/Mobile Documents"
        let extra = ["Desktop", "Documents", "Downloads", mobile, cloud].filter { id in
            !all.contains { $0.id == id || (id == mobile && $0.id == icloud) }
        }.map { join(homeDir, $0) }
        return Guard(allowed: allowed, blocked: blocked, answers: said, homeDir: homeDir, guarded: blocked.map(\.covers) + extra,
                     free: allowed.map(\.covers) + picked.filter { !$0.isEmpty }.map { resolve($0) })
    }

    /// The protected folder `dir` is in, of `folders`, or nil.
    public static func folderOf(_ folders: [Folder], _ dir: String) -> Folder? { folders.first { inside(resolve(dir), $0.covers) } }

    /// The protected folders a run with these choices would read and that were never asked about: all of them when PDFs
    /// on this Mac is ticked with file access on; the one above each ticked local repo; else none.
    public static func needed(_ choices: JSONValue?, homeDir: String, dataRoot: URL? = nil) -> [(id: String, name: String)] {
        let all = protectedFolders(homeDir: homeDir)
        let said = readAnswers(dataRoot: dataRoot)
        var want = Set<String>()
        let sources = choices?["sources"]?.object ?? [:]
        let files = JS.truthy(choices?["permissions"]?["files"]) || JS.truthy(choices?["computer"])
        if let papers = sources["papers"], JS.truthy(papers) {
            let pdfs = papers["on"] != .bool(false) && (papers["apps"]?.array.map { $0.contains(.string(ConnectSources.localPDFs)) } ?? JS.truthy(papers["on"]))
            if pdfs && files { all.forEach { want.insert($0.id) } }
        }
        let full: (String) -> String = { raw in raw.hasPrefix("~/") ? join(homeDir, String(raw.dropFirst(2))) : raw }
        // A folder the person picked themselves needs no asking: macOS lets Engelbart read it.
        let picked = (choices?["picked"]?.array ?? []).map { full(JS.string($0)) }.filter { $0.hasPrefix("/") }
        if let code = sources["code"], JS.truthy(code), code["on"] != .bool(false) {
            for dir in (code["folders"]?.array ?? []).map({ full(JS.string($0)) }) {
                if !dir.hasPrefix("/") || picked.contains(where: { inside(resolve(dir), resolve($0)) }) { continue }
                if let folder = folderOf(all, dir) { want.insert(folder.id) }
            }
        }
        return all.filter { want.contains($0.id) && said[$0.id] == nil }.map { ($0.id, $0.name) }
    }

    /// Reads each of `ids` in turn, so that macOS asks about them one after another → [id: 'allowed' | 'denied'], and
    /// writes the answers to folders.json. A folder that is not there is left out.
    public static func ask(_ ids: [String], homeDir: String, dataRoot: URL? = nil, now: Date = Date()) async -> [String: String] {
        let all = protectedFolders(homeDir: homeDir)
        var answers: [String: String] = [:]
        for id in ids {
            guard let folder = all.first(where: { $0.id == id }) else { continue }
            do {
                _ = try FileManager.default.contentsOfDirectory(atPath: folder.path)
                answers[id] = "allowed"
            } catch let error as NSError {
                if error.code == NSFileReadNoSuchFileError || (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.code == Int(ENOENT) { continue }
                answers[id] = "denied"
            }
        }
        if !answers.isEmpty { writeAnswers(dataRoot: dataRoot, answers, now: now) }
        return answers
    }
}
