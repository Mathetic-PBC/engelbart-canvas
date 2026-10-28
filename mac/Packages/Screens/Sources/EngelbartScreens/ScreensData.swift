import EngelbartCore
import EngelbartDoc
import EngelbartStore
import Foundation

// What the screens ask of the Store (the api.* calls of Home.jsx and Onboarding.jsx, ipc.cjs). The app passes
// `StoreScreensData(store:)`; tests pass a fake. Every call is the renderer's, under the same name.

/// The all-projects screen's calls.
public protocol HomeData: AnyObject {
    /// api.addLibraryItem: a new row, or a throw ("Already in the library as “X”" among them).
    func addLibraryItem(_ input: String) async throws -> LibraryRow
    /// api.addLibraryFile (a dropped picture or file without a path): its bytes kept as a copy.
    func addLibraryFile(_ bytes: Data, mime: String, name: String?) async throws -> LibraryRow
    /// api.addLibraryUrl (a dropped link, read first).
    func addLibraryUrl(_ input: String) async throws -> LibraryRow
    /// api.pickLibraryPaths(kind): files and folders from disk ('pdf': pdfs only); [] when cancelled.
    func pickLibraryPaths(_ kind: String?) async -> [String]
    /// api.previewLibraryItem: what the peek adds (an md's text, files, lines, who holds it).
    func previewLibraryItem(_ id: String) async throws -> Library.Preview
    /// api.projectsForLibraryItem: the projects (and their workspaces) that hold the row.
    func projectsForLibraryItem(_ id: String) async throws -> [Library.Holder]
    /// api.libraryBodies(null): what the whole library's pdfs and notes say, by row id.
    func libraryBodies() async throws -> [String: String]
}

/// Onboarding's calls.
public protocol OnboardingData: AnyObject {
    func library() async throws -> [LibraryRow]
    /// api.addLibraryItem: the row, and the sandbox error a GitHub repository's add may carry (said, not refused).
    func addLibraryItem(_ input: String) async throws -> (row: LibraryRow, sandboxError: String?)
    /// api.lookupLibraryItem: the row that already is this address or path, without adding it.
    func lookupLibraryItem(_ input: String) async throws -> LibraryRow?
    /// api.discardLibraryItem: removed only while nothing holds it.
    func discardLibraryItem(_ id: String) async throws -> Bool
    func pickLibraryPaths(_ kind: String?) async -> [String]
    func instructions() async throws -> String
    func setInstructions(_ text: String) async throws
    /// api.freeFolder: "~/<slug>" not taken yet, as shown.
    func freeFolder(_ name: String) async throws -> String
    /// api.checkFolder: throws when the folder is not there.
    func checkFolder(_ path: String) async throws
    /// api.startProject.
    func startProject(_ input: OnboardingFlow.ProjectInput) async throws -> Onboarded
    /// api.welcomeWorkspace.
    func welcomeWorkspace(_ projectId: String, context: [String], connect: String?) async throws -> Onboarded
    /// The project's name and description (api.loadProject's), for the librarian.
    func projectAbout(_ id: String) async throws -> ProjectAbout
    /// api.connectOfferSeen('started' | 'dismissed').
    func connectOfferSeen(_ how: String) async
}

/// What the librarian is told the project is (never its id: an onboarding session with one would not be picked up again).
public struct ProjectAbout: Equatable, Sendable {
    public var name: String
    public var description: String
    public init(name: String, description: String) { self.name = name; self.description = description }
}

/// What onboarding made (start-project, welcome-workspace), and where App.jsx `onboarded` lands.
public struct Onboarded: Equatable, Sendable {
    public var projectId: String
    public var projectName: String
    public var workspaceId: String?
    public var noteId: String?
    public var noteName: String?
    public var welcomePage: Bool
    /// The Getting started walkthrough's state was made with it (a new user's, the guided setup's).
    public var gettingStarted: Bool
    public var importedNotes: Int?
    public init(projectId: String, projectName: String = "", workspaceId: String?, noteId: String? = nil, noteName: String? = nil,
                welcomePage: Bool = false, gettingStarted: Bool = false, importedNotes: Int? = nil) {
        self.projectId = projectId; self.projectName = projectName; self.workspaceId = workspaceId; self.noteId = noteId; self.noteName = noteName
        self.welcomePage = welcomePage; self.gettingStarted = gettingStarted; self.importedNotes = importedNotes
    }

    /// The tab the project opens with (App.jsx onboarded): the Welcome! note, unless the made thing has the walkthrough,
    /// the Welcome page or no note (a new user's lands on its Welcome workspace's own document, 2026-10-09).
    public var landingTab: (id: String, title: String)? {
        if gettingStarted || welcomePage { return nil }
        guard let noteId, !noteId.isEmpty else { return nil }
        return (noteId, noteName ?? "")
    }

    public init(_ made: Projects.Welcomed) {
        self.init(projectId: made.project.id, projectName: made.project.name, workspaceId: made.workspaceId, noteId: made.noteId,
                  noteName: made.noteName, welcomePage: made.welcomePage ?? false, gettingStarted: made.gettingStarted != nil,
                  importedNotes: made.importedNotes)
    }
    public init(_ made: Onboarding.WelcomeWorkspace) {
        self.init(projectId: made.project.id, projectName: made.project.name, workspaceId: made.workspaceId,
                  gettingStarted: made.gettingStarted != nil, importedNotes: made.importedNotes)
    }
}

/// Extra things onboarding hands back with what it made (App.jsx onboarded's second argument).
public struct OnboardedExtras: Equatable, Sendable {
    /// The sites the sign-ins picker said to sign in to again: they open on the Stage once the project opens.
    public var stageLinks: [String]
    /// Import your context's session, when it ran.
    public var session: String?
    public init(stageLinks: [String] = [], session: String? = nil) { self.stageLinks = stageLinks; self.session = session }
}

/// The Store as the screens' data (ipc.cjs's handlers for their calls).
public final class StoreScreensData: HomeData, OnboardingData, @unchecked Sendable {
    public let store: Store
    public init(store: Store) { self.store = store }

    public func addLibraryItem(_ input: String) async throws -> LibraryRow { try await store.addLibraryItem(input).row }
    public func addLibraryFile(_ bytes: Data, mime: String, name: String?) async throws -> LibraryRow { try await store.addLibraryFile(bytes, mime: mime, name: name) }
    public func addLibraryUrl(_ input: String) async throws -> LibraryRow { try await store.addLibraryUrl(input).row }
    public func pickLibraryPaths(_ kind: String?) async -> [String] { await store.pickLibraryPaths(kind ?? "") }
    public func previewLibraryItem(_ id: String) async throws -> Library.Preview { try await store.previewLibraryItem(id) }
    public func projectsForLibraryItem(_ id: String) async throws -> [Library.Holder] { try await store.projectsForLibraryItem(id) }
    public func libraryBodies() async throws -> [String: String] { try await store.libraryBodies(nil).items }

    public func library() async throws -> [LibraryRow] { try await store.library() }
    public func addLibraryItem(_ input: String) async throws -> (row: LibraryRow, sandboxError: String?) {
        let added = try await store.addLibraryItem(input)
        return (added.row, added.sandboxError)
    }
    public func lookupLibraryItem(_ input: String) async throws -> LibraryRow? { try await store.lookupLibraryItem(input).row }
    public func discardLibraryItem(_ id: String) async throws -> Bool { try await store.discardLibraryItem(id) }
    public func instructions() async throws -> String { try await store.instructions() }
    public func setInstructions(_ text: String) async throws { try await store.setInstructions(text) }
    public func freeFolder(_ name: String) async throws -> String { try await store.freeFolder(name).shown }
    public func checkFolder(_ path: String) async throws { _ = try await store.checkFolder(path) }
    public func startProject(_ input: OnboardingFlow.ProjectInput) async throws -> Onboarded {
        Onboarded(try await store.startProject(input.start, connect: input.connect, onboarding: input.onboarding))
    }
    public func welcomeWorkspace(_ projectId: String, context: [String], connect: String?) async throws -> Onboarded {
        Onboarded(try await store.welcomeWorkspace(projectId, context: context, connect: connect))
    }
    public func projectAbout(_ id: String) async throws -> ProjectAbout {
        let tree = try await store.loadProject(id)
        return ProjectAbout(name: tree.project.name, description: tree.project.description)
    }
    public func connectOfferSeen(_ how: String) async { try? await store.connectOfferSeen(how) }
}

/// A Store row as the Doc models read it.
extension LibraryRow {
    var lib: LibRow {
        LibRow(id: id, name: name, type: type, tags: tags, path: path, folderPath: folderPath, url: url, summary: summary, projectId: projectId, source: source)
    }
}

/// The message a failure shows (api.js errorMessage): its own words.
func errorMessage(_ error: Error) -> String {
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return (error as NSError).localizedDescription
}
