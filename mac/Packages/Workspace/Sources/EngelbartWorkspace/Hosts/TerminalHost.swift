import AppKit
import EngelbartCore
import EngelbartTerminal
import EngelbartSandbox

/// The terminal pane's side of the workspace (RightPane.jsx's props to <TerminalPane>): the project and its code directory,
/// links to the Stage, which side has ⌘T (key-side.js), the full-screen arrows, a sandbox kept awake while its tab shows.
@MainActor
final class WorkspaceTerminalHost: TerminalHost {
    unowned let model: WorkspaceModel
    var keysToDocNow: () -> Bool = { false }
    lazy var touch: SandboxTouch? = model.ctx.touchSandbox.map { t in SandboxTouch(touch: t) }

    init(model: WorkspaceModel) { self.model = model }

    var terminalProjectId: String? { model.projectId }
    var terminalProjectDirectory: String? { model.project.directory }
    /// OPEN_IN_BROWSER: the link on the Stage, the Stage shown.
    func terminalOpenLink(_ url: String) { model.openLink(url) }
    func terminalKeysToDoc() -> Bool { keysToDocNow() }
    var terminalFullScreen: Bool? { model.stageFull }
    func terminalToggleFullScreen() { model.toggleStageFull() }
    func terminalTouchSandbox(libraryId: String) { touch?.update(libraryId: libraryId, focused: model.windowIsKey()) }
}
