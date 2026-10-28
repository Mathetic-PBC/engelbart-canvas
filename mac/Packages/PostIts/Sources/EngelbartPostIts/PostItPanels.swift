import AppKit
import SwiftUI
import Combine
import EngelbartCore
import EngelbartUI

/// Where a popup hangs from: a card's button, a rect of the window (an Agents row), or nowhere given.
enum PanelAnchor {
    case view(NSView)
    case rect(CGRect)
    case none
}

/// A post-it's Build popup and its quick task's card (Claude Design "Post-it Quick Task", 2026-09-27; Workspace.jsx
/// postItBuild / quickTask), each hanging from the card's button that opened it, with the popouts beside them (Context;
/// the task card's model grid). They are child windows above the window, so they cover the cards they reach (B29).
/// One key monitor and one press monitor stand for the popups' window listeners (capture phase): Escape closes the newest
/// popout, else the popup (never while it is sending); ⌘/Ctrl+Enter sends the Build; a press in the window that is not on
/// a card closes them (cards were views of their own in Electron, so a press on one never reached the page).
@MainActor
final class PostItPanels {
    weak var controller: PostItsController?

    var buildPanel: FloatingPanel?
    var buildModel: PostItBuildModel?
    var buildButton: CGRect?
    var contextPanel: FloatingPanel?
    var contextModel: ContextModel?
    var taskPanel: FloatingPanel?
    var taskModel: PostItTaskModel?
    var modelPanel: FloatingPanel?
    var watches: [AnyCancellable] = []
    var monitors: [Any] = []

    var window: NSWindow? { controller?.overlay.window }

    // MARK: Build popup

    func toggleBuild(postItId: String, text: String, anchor: NSView) {
        closeTask()
        if buildModel?.postItId == postItId { closeBuild(); return }
        closeBuild()
        guard let controller, let projectId = controller.projectId, let build = controller.context.build, let window else { return }
        let model = PostItBuildModel(projectId: projectId, postItId: postItId, text: text, build: build, memory: controller.context.pickMemory)
        model.onStarted = { [weak self] task in self?.controller?.buildState(task); self?.closeBuild() }
        model.onLibraryChanged = { [weak controller] in controller?.context.libraryChanged() }
        buildModel = model
        let rect = FloatingPanel.anchorRect(of: anchor)
        buildButton = rect
        let panel = FloatingPanel()
        buildPanel = panel
        panel.show(in: window, anchor: rect, options: Self.options(width: PostItBuildView.WIDTH)) {
            PostItBuildView(model: model)
        }
        watch(model) { [weak self] in self?.relayoutBuild() }
        install()
        Task { await model.load() }
    }

    func relayoutBuild() {
        guard let panel = buildPanel, let model = buildModel else { return }
        panel.relayout()
        if model.ctxOpen { showContext() } else { closeContext() }
        if let p = contextPanel { placeBeside(p, of: panel, width: ContextPopoutView.WIDTH) }
    }

    func showContext() {
        guard contextPanel == nil, let window, let controller, let buildModel, let buildPanel else { return }
        let model = ContextModel(build: buildModel, context: controller.context)
        contextModel = model
        let panel = FloatingPanel()
        contextPanel = panel
        panel.show(in: window, anchor: .zero, options: Self.options(width: ContextPopoutView.WIDTH, rise: 0.14, gap: 0, align: .start)) {
            ContextPopoutView(model: model)
        }
        placeBeside(panel, of: buildPanel, width: ContextPopoutView.WIDTH)
        watch(model) { [weak self] in
            guard let self, let p = self.contextPanel, let b = self.buildPanel else { return }
            p.relayout(); self.placeBeside(p, of: b, width: ContextPopoutView.WIDTH)
        }
        Task { await model.open() }
    }

    func closeContext() {
        guard let panel = contextPanel else { return }
        contextPanel = nil
        contextModel = nil
        panel.update { EmptyView() }
        panel.close()
    }

    func closeBuild() {
        closeContext()
        if let panel = buildPanel { panel.update { EmptyView() }; panel.close() }
        buildPanel = nil; buildModel = nil; buildButton = nil
        uninstallIfIdle()
    }

    // MARK: quick task card

    func toggleTask(id: String, postItId: String?, anchor: PanelAnchor) {
        if taskModel?.taskId == id { closeTask(); return }
        openTask(id: id, postItId: postItId, anchor: anchor)
    }

    func openTask(id: String, postItId: String?, anchor: PanelAnchor) {
        closeTask()
        guard let controller, let projectId = controller.projectId, let build = controller.context.build, let window else { return }
        guard let task = controller.tasks[id] else { return } // shown only while the record is known (Workspace.jsx)
        let workspaces = controller.context.workspaces()
        let model = PostItTaskModel(projectId: projectId, task: task, progress: controller.progress[id], postItId: postItId, build: build,
                                    workspaces: workspaces, hereId: controller.context.hereWorkspaceId())
        model.onAction = { [weak self] action in
            guard let self, let controller = self.controller else { return }
            Task { @MainActor in
                do {
                    if action == "stop" { _ = try await build.buildStop(projectId, id) }
                    else if action == "discard" { controller.buildState(try await build.buildDiscard(projectId, id)) }
                } catch { controller.report(error) }
            }
        }
        model.onPromoted = { [weak self] moved in
            guard let self, let controller = self.controller else { return }
            controller.buildState(moved)
            if let postItId { Task { @MainActor in do { try await controller.throwOut(postItId) } catch { controller.report(error) } } }
            if let ws = moved["workspaceId"]?.string, let version = moved["version"], !version.isNull { controller.context.goToVersion(ws, version) }
            self.closeTask()
        }
        model.onClose = { [weak self] in self?.closeTask() }
        taskModel = model
        let rect: CGRect
        switch anchor {
        case .view(let view): rect = FloatingPanel.anchorRect(of: view)
        case .rect(let r): rect = r
        case .none:
            let size = window.contentView?.bounds.size ?? .zero
            rect = CGRect(x: size.width / 2 + PostItTaskView.WIDTH / 2, y: 56, width: 0, height: 0)
        }
        buildButton = rect
        let panel = FloatingPanel()
        taskPanel = panel
        panel.show(in: window, anchor: rect, options: Self.options(width: PostItTaskView.WIDTH)) { PostItTaskView(model: model) }
        watch(model) { [weak self] in self?.relayoutTask() }
        install()
        Task { await model.load() }
    }

    func relayoutTask() {
        guard let panel = taskPanel, let model = taskModel else { return }
        panel.relayout()
        if model.modelOpen && model.models != nil { showTaskModels() } else { closeTaskModels() }
        if let p = modelPanel { placeBeside(p, of: panel, width: PostItTaskView.WIDTH) }
    }

    func showTaskModels() {
        guard modelPanel == nil, let window, let model = taskModel, let taskPanel else { return }
        let panel = FloatingPanel()
        modelPanel = panel
        panel.show(in: window, anchor: .zero, options: Self.options(width: PostItTaskView.WIDTH, rise: 0.14, gap: 0, align: .start)) {
            TaskModelGridView(model: model)
        }
        placeBeside(panel, of: taskPanel, width: PostItTaskView.WIDTH)
    }

    func closeTaskModels() {
        guard let panel = modelPanel else { return }
        modelPanel = nil
        panel.update { EmptyView() }
        panel.close()
    }

    func closeTask() {
        closeTaskModels()
        if let panel = taskPanel { panel.update { EmptyView() }; panel.close() }
        taskPanel = nil; taskModel = nil
        if buildPanel == nil { buildButton = nil }
        uninstallIfIdle()
    }

    /// A record or its progress changed: the task card follows it.
    func taskChanged() {
        guard let model = taskModel, let controller else { return }
        if let task = controller.tasks[model.taskId] { model.task = task }
        model.progress = controller.progress[model.taskId]
    }

    func cardGone(_ id: String) {
        if buildModel?.postItId == id { closeBuild() }
    }

    func closeAll() { closeBuild(); closeTask() }

    // MARK: placing

    static func options(width: CGFloat, rise: TimeInterval = 0.16, gap: CGFloat = 8, align: PlaceAlign = .end) -> FloatingOptions {
        // The CSS draws its own white card with a 1 px border and no shadow; Escape and presses are PostItPanels'.
        FloatingOptions(side: .below, gap: gap, align: align, width: width, card: false, rise: rise, takesKey: true, dismissible: false)
    }

    /// ModelGrid.jsx useBeside: beside the panel, bottoms level, on its right when `width` + 6 fits there with 8 to spare,
    /// else on its left.
    func placeBeside(_ panel: FloatingPanel, of parent: FloatingPanel, width: CGFloat) {
        guard let spot = parent.spot, let view = window?.contentView?.bounds.size else { return }
        let r = CGRect(x: spot.left, y: spot.top, width: parent.cardSize.width, height: parent.cardSize.height)
        let right = view.width - r.maxX - 8 >= width + 6
        let left = right ? r.maxX + 6 : max(8, r.minX - 6 - width)
        let bottom = max(8, view.height - r.maxY)
        let top = view.height - bottom - panel.cardSize.height
        panel.move(anchor: CGRect(x: left, y: top, width: width, height: 0))
    }

    func watch<M: ObservableObject>(_ model: M, _ then: @escaping () -> Void) where M.ObjectWillChangePublisher == ObservableObjectPublisher {
        watches.append(model.objectWillChange.receive(on: DispatchQueue.main).sink { _ in MainActor.assumeIsolated { then() } })
    }

    // MARK: keys and presses

    var ownWindows: [NSWindow] { [buildPanel, contextPanel, taskPanel, modelPanel].compactMap { $0?.window } }

    func install() {
        guard monitors.isEmpty else { return }
        if let key = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard let self else { return event }
            return self.key(event) ? nil : event
        }) { monitors.append(key) }
        if let press = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] event in
            self?.press(event)
            return event
        }) { monitors.append(press) }
    }

    func uninstallIfIdle() {
        guard buildPanel == nil, taskPanel == nil else { return }
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        watches = []
    }

    /// Is the event for these popups (the window, or one of their own panels and the dropdowns opened from them)?
    func ours(_ event: NSEvent) -> Bool {
        guard let w = event.window else { return false }
        if w === window || ownWindows.contains(where: { $0 === w }) { return true }
        return w.parent != nil && (w.parent === window || ownWindows.contains { $0 === w.parent })
    }

    /// → whether the key was used.
    func key(_ event: NSEvent) -> Bool {
        guard ours(event) else { return false }
        if event.keyCode == 53 { // Escape
            if let model = buildModel {
                if model.ctxOpen { model.ctxOpen = false; return true }
                if !model.busy { closeBuild() }
                return true
            }
            if let model = taskModel {
                if model.modelOpen { model.modelOpen = false; return true }
                closeTask()
                return true
            }
            return false
        }
        if event.keyCode == 36 || event.keyCode == 76, !event.modifierFlags.intersection([.command, .control]).isEmpty, let model = buildModel {
            Task { await model.send() }
            return true
        }
        return false
    }

    func press(_ event: NSEvent) {
        guard let window, event.window === window, let content = window.contentView else { return }
        // A press on a card is the card's (a separate view in Electron: the page never heard it).
        if let overlay = controller?.overlay, let sup = overlay.superview, overlay.hitTest(sup.convert(event.locationInWindow, from: nil)) != nil { return }
        _ = content
        if let model = buildModel, !model.busy { closeBuild() }
        if let model = taskModel, !model.busy { closeTask() }
    }
}
