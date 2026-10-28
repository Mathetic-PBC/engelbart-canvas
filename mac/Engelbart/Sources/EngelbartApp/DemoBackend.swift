import EngelbartCore
import Foundation

/// Scripted runs of the shell before the Store is wired (wave 1 only): `ENGELBART_SHELL_DEMO` picks a pretend library.
///   home       one project, opened on the projects screen
///   workspace  one project with a code directory, opened on its workspace
///   gate       one project whose directory went missing (the DirectoryGate)
///   kit        the projects screen showing every UI-kit primitive (KitGallery.swift)
/// `ENGELBART_SHELL_SETTINGS=<page>` opens Settings on that page ("" the first) once the window is up. Nothing is written.
public final class DemoBackend: ShellBackend {
    public enum Mode: String { case home, workspace, gate, kit }
    let mode: Mode
    var current: ShellConfig
    let paths: AppPaths
    let projectId = "11111111-2222-4333-8444-555555555555"
    let workspaceId = "66666666-7777-4888-8999-000000000000"
    var directory: String?

    public init?(environment: [String: String], paths: AppPaths, testModeAvailable: Bool) {
        guard let raw = environment["ENGELBART_SHELL_DEMO"], let mode = Mode(rawValue: raw) else { return nil }
        self.mode = mode
        self.paths = paths
        current = ShellConfig(dataRoot: paths.dataRoot.path, testMode: false, testModeAvailable: testModeAvailable, testRoot: paths.testRoot.path)
        directory = mode == .gate ? nil : paths.home.path
    }

    public func config() async throws -> ShellConfig { current }
    public func trashedProjects() async throws -> [ProjectSummary] { [] }
    public func listProjects() async throws -> [ProjectSummary] { [ProjectSummary(id: projectId, name: "Fellowship")] }
    public func library() async throws -> [JSONValue] { [] }
    public func loadProject(_ id: String) async throws -> ProjectTree {
        ProjectTree(project: .init(id: projectId, name: "Fellowship", directory: directory,
                                   directoryMissing: mode == .gate && directory == nil ? "~/code/fellowship" : nil),
                    workspaces: [.init(id: workspaceId, name: "Getting started")], notes: [])
    }
    public func views(_ id: String) async throws -> JSONValue { .object([:]) }
    public func createWorkspace(_ projectId: String, name: String) async throws {}
    public func lastOpen() async -> WindowPlace? { mode == .home || mode == .kit ? nil : WindowPlace(projectId: projectId, workspaceId: workspaceId) }
    public func setLastOpen(_ place: WindowPlace) async {}
    public func setProjectDirectory(_ id: String, _ directory: String) async throws { self.directory = directory }
    public func setTestMode(_ on: Bool) async throws -> ShellConfig {
        current.testMode = on
        current.dataRoot = on ? paths.testRoot.path : paths.dataRoot.path
        return current
    }
    public func resetTestData(fresh: Bool) async throws -> (reset: Bool, config: ShellConfig) { (true, current) }
    public func trashProject(_ id: String) async throws {}
    public func restoreProject(_ id: String) async throws {}
    public func renameProject(_ id: String, _ name: String) async throws {}
    public func guidedOffer() async -> Bool { false }
    public func guidedOfferSeen(_ how: String) async {}
    public func pendingImport() async -> String? { nil }
}
