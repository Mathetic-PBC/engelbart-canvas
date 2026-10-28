import Foundation
import EngelbartCore

/// The first layout put a workspace two levels down: <project>/<Goal>/<Topic>/workspace.md (migrate.cjs). This converts a
/// project directory in place and never deletes anything: a backup (no database files) to
/// `<dataRoot>/.backups/<project>-<stamp>/`; each goal folder to `<project>/.legacy/<Goal>/`; each topic up to the project
/// (" 2", " 3" for a taken name), its meta.json kept so its id and notes still match; context folders flattened.
public enum Migrate {
    static let boxes = ["current", "experimental", "past"]

    public struct Report: Codable, Equatable, Sendable {
        public struct Move: Codable, Equatable, Sendable { public var from: String; public var to: String }
        public struct Folders: Codable, Equatable, Sendable { public var workspace: String; public var removed: [String] }
        public var project: String
        public var backup: String
        public var goals: [String]
        public var moved: [Move]
        public var folders: [Folders]
    }

    static func subdirs(_ dir: String) -> [String] {
        (Paths.listDir(dir) ?? []).sorted().compactMap { name in
            name.hasPrefix(".") || name.hasSuffix(".pglite") ? nil : (Paths.isRealDirectory(Paths.join(dir, name)) ? Paths.join(dir, name) : nil)
        }
    }

    static func meta(_ dir: String) -> JSONValue? { JSONFiles.read(Paths.join(dir, "meta.json")) }
    static func isGoal(_ dir: String) -> Bool {
        guard let m = meta(dir), m["id"]?.string != nil else { return false }
        return boxes.contains(m["box"]?.string ?? "") && !Projects.statuses.contains(m["status"]?.string ?? "")
    }
    static func isWorkspace(_ dir: String) -> Bool {
        guard let m = meta(dir), m["id"]?.string != nil else { return false }
        return Projects.statuses.contains(m["status"]?.string ?? "")
    }
    static func hasFolders(_ entries: JSONValue?) -> Bool { (entries?.array ?? []).contains { $0.isPlainObject } }
    static func flatIds(_ entries: JSONValue?, _ out: inout [String]) {
        for entry in entries?.array ?? [] {
            if let id = entry.string { if !out.contains(id) { out.append(id) } } else if entry.isPlainObject { flatIds(entry["children"], &out) }
        }
    }
    static func folderNames(_ entries: JSONValue?, _ out: inout [String]) {
        for entry in entries?.array ?? [] where entry.isPlainObject {
            out.append(entry["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "folder")
            folderNames(entry["children"], &out)
        }
    }

    /// Every workspace directory under `dir`, at any depth (also inside goal directories that are about to move).
    static func workspacesUnder(_ dir: String, depth: Int = 0) -> [String] {
        if depth > 34 { return [] }
        var out: [String] = []
        for child in subdirs(dir) {
            if isWorkspace(child) { out.append(child) }
            if isWorkspace(child) || isGoal(child) { out.append(contentsOf: workspacesUnder(child, depth: depth + 1)) }
        }
        return out
    }

    /// What converting `projectDir` would do (or did): nil when there is nothing to convert.
    @discardableResult
    public static func migrateProjectDir(_ projectDir: String, dryRun: Bool = false, now: Date = Date()) throws -> Report? {
        let goals = subdirs(projectDir).filter(isGoal)
        let foldered = workspacesUnder(projectDir).filter { hasFolders(meta($0)?["context"]) }
        if goals.isEmpty && foldered.isEmpty { return nil }
        let stamp = Time.iso(now).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
        let backup = Paths.join(Paths.dirname(projectDir), ".backups", "\(Paths.basename(projectDir))-\(stamp)")
        let legacy = Paths.join(projectDir, ".legacy")
        var report = Report(project: projectDir, backup: backup, goals: goals.map(Paths.basename), moved: [], folders: [])
        for dir in foldered { var names: [String] = []; folderNames(meta(dir)?["context"], &names); report.folders.append(.init(workspace: Paths.basename(dir), removed: names)) }

        if dryRun {
            var taken = Set((Paths.listDir(projectDir) ?? []).filter { !goals.contains(Paths.join(projectDir, $0)) })
            for goal in goals {
                for topic in subdirs(goal).filter(isWorkspace) {
                    var name = Paths.basename(topic), n = 2
                    while taken.contains(name) { name = "\(Paths.basename(topic)) \(n)"; n += 1 }
                    taken.insert(name)
                    report.moved.append(.init(from: Paths.relative(projectDir, topic), to: name))
                }
            }
            return report
        }

        try JSONFiles.makeDir(Paths.dirname(backup))
        try copyTree(projectDir, backup)
        try JSONFiles.makeDir(legacy)
        for goal in goals {
            let parked = Paths.join(legacy, Names.uniqueName(legacy, Paths.basename(goal)))
            try FileManager.default.moveItem(atPath: goal, toPath: parked)
            for topic in subdirs(parked).filter(isWorkspace) {
                let name = Names.uniqueName(projectDir, Paths.basename(topic))
                try FileManager.default.moveItem(atPath: topic, toPath: Paths.join(projectDir, name))
                report.moved.append(.init(from: Paths.join(Paths.basename(goal), Paths.basename(topic)), to: name))
            }
        }
        // Context folders are gone (a nested workspace does that job): what a folder held stays, flat and in order.
        for dir in workspacesUnder(projectDir) {
            let file = Paths.join(dir, "meta.json")
            if let m = JSONFiles.read(file), hasFolders(m["context"]) {
                var ids: [String] = []; flatIds(m["context"], &ids)
                try JSONFiles.write(file, m.merging(["context": .array(ids.map { .string($0) })]))
            }
        }
        try JSONFiles.write(Paths.join(legacy, "migration-\(stamp).json"), JSONValue.encode(report).merging(["at": .string(Time.iso(now))]))
        return report
    }

    /// fs.cpSync recursive, leaving the project's database files out.
    static func copyTree(_ from: String, _ to: String) throws {
        try JSONFiles.makeDir(to)
        for name in Paths.listDir(from) ?? [] {
            if Projects.isDatabaseFile(name) { continue }
            let source = Paths.join(from, name), target = Paths.join(to, name)
            if Paths.isRealDirectory(source) { try copyTree(source, target) } else { try FileManager.default.copyItem(atPath: source, toPath: target) }
        }
    }
}
