import AppKit
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// Drawing the sidebar from the controller's state (Rail.jsx's render): the head, the fixed rows, Projects, Sources, the
// foot. Rebuilt whole on each change (a few dozen rows); a row under the pointer gets its hover back at once.

extension SidebarViewController {
    func render() {
        guard isViewLoaded else { return }
        root.isHidden = input.hidden
        root.frame.size.width = input.width
        rows = [:]
        renderHead()
        renderList()
        renderFoot()
        root.needsLayout = true
        root.layoutSubtreeIfNeeded()
        for case let row as SBRowView in rows.values { row.syncHover() }
        installEscape()
    }

    // MARK: the head

    private func renderHead() {
        let head = root.head
        head.project.name = input.project.name
        head.project.on = panel?.kind == "project"
        head.newNote.enabled = input.canNewNote
        if renaming == "project" {
            if !(head.renameBox?.subviews.first is RenameField) {
                let box = RenameBox()
                let field = RenameField(initial: input.project.name, font: Fonts.sans(15, weight: 600))
                field.onDone = { [weak self] name in self?.endRename(); if let name { self?.context.actions.renameProject(name) } }
                box.addSubview(field)
                box.field = field
                head.renameBox = box
            }
        } else if head.renameBox != nil { head.renameBox = nil }
        rows["sb-trigger=project"] = head.project
        head.needsLayout = true
    }

    // MARK: the middle

    private func renderList() {
        let list = root.list
        list.subviews.forEach { $0.removeFromSuperview() }
        let L = ListLayout(list: list, width: max(0, input.width - 16))
        func place(_ view: NSView, x: CGFloat = 0, height: CGFloat = SB.LINE, gap: CGFloat = 0) { L.place(view, x, height, gap) }
        let a = context.actions

        // Fixed in place: Agents, Library, Search.
        let agentsSummary = SidebarModel.summarize(input.entries)
        let agents = row(SBRowView.Look(icon: SidebarIcons.agents, label: "Agents", active: panel?.kind == "agents"), id: "sb-trigger=agents")
        let pill = SBCountView(summary: agentsSummary, pill: true)
        pill.setAccessibilityIdentifier("sb-count=agents")
        pill.frame.size = pill.fitting
        agents.accessories = [pill]
        agents.onClick = { [weak self, weak agents] _ in guard let self, let agents else { return }; self.togglePanel("agents", element: agents) }
        place(agents, gap: 1)

        let libraryTotal = Kind.libraryCounts(input.library.map(\.lib))["all"] ?? 0
        let library = row(SBRowView.Look(icon: SidebarIcons.library, label: "Library", active: panel?.kind == "library"), id: "sb-trigger=library")
        let size = SBLabel(SidebarModel.libraryLabel(libraryTotal), font: Fonts.sans(12), color: Palette.fnt, id: "sb-count=library")
        rows["sb-count=library"] = size
        size.tabular = true
        size.sizeToText(height: 16)
        library.accessories = [size]
        library.onClick = { [weak self, weak library] _ in guard let self, let library else { return }; self.togglePanel("library", element: library) }
        place(library, gap: 1)

        let search = row(SBRowView.Look(icon: SidebarIcons.search, label: "Search", active: searching), id: "sb-fixed-row=search")
        search.onClick = { [weak self] _ in self?.showSearch() }
        place(search)

        // Projects: the shortlist, what is open under it, More.
        L.y += 12
        let projectsOpen = isOpen("section:projects", true)
        let projectsHead = sectionHead("Projects", open: projectsOpen, key: "projects")
        let next = SBLabel("⌘J", font: Fonts.sans(12), color: Palette.fnt, id: "sb-next-agent")
        rows["sb-next-agent"] = next
        next.hoverFill = Palette.gray150
        next.sizeToText(padX: 3, height: 20)
        next.setAccessibilityLabel("Next agent needing attention (⌘J)")
        next.action = { [weak self] in self?.showTip(nil); a.nextAgent() }
        next.onHoverChange = { [weak self] view, on in if on { self?.labelTip(view, "Next agent needing attention") } else { self?.showTip(nil) } }
        let spacer = SBView(frame: CGRect(x: 0, y: 0, width: 3, height: 1)) // the ⌘J's margin-right 8 (5 of it is the gap)
        let plus = addButton("Create project within \(input.project.name)", id: "sb-new-workspace") { [weak self] _ in self?.create(nil) }
        projectsHead.accessories = [next, spacer, plus]
        place(projectsHead)
        if projectsOpen {
            if input.roots.isEmpty {
                let none = SBLabel("No projects yet", font: Fonts.sans(13), color: SB.empty)
                none.frame.size.height = SB.LINE
                let holder = SBView(frame: .zero)
                holder.addSubview(none)
                place(holder)
                none.frame = CGRect(x: 10, y: 0, width: textWidth("No projects yet", font: Fonts.sans(13)) + 2, height: SB.LINE)
            }
            for id in plan.order { projectRows(id, x: 0, L) }
            if !plan.hidden.isEmpty {
                let more = moreRow(id: "sb-more=projects", count: SidebarModel.summaryOf(tree, input.entries, plan.hidden), open: panel?.kind == "projects")
                more.onClick = { [weak self, weak more] _ in guard let self, let more else { return }; self.togglePanel("projects", element: more) }
                rows["sb-more=projects"] = more
                place(more)
            }
        }

        // Sources: this project's folder, the person's own folders, Create new.
        L.y += 12
        list.sourcesTop = L.y
        let sourcesOpen = isOpen("section:sources", true)
        let sourcesHead = sectionHead("Sources", open: sourcesOpen, key: "sources")
        if input.hereId != nil {
            let add = addButton("Add sources to this project and library", id: "sb-add-sources") { [weak self] button in self?.addTo(button, folder: nil) }
            rows["sb-trigger=add:project"] = add
            sourcesHead.accessories = [add]
        }
        rows["sb-head=sources"] = sourcesHead
        place(sourcesHead)
        if sourcesOpen {
            if let here = input.hereId {
                folderGroup(key: "folder:\(here)", name: nameOf(here) ?? "This project", list: input.rows, folder: nil, defaultOpen: true, L)
            }
            for folder in folders { folderGroup(key: "folder:\(folder.id)", name: folder.name, list: folderRowsOf(folder), folder: folder, defaultOpen: false, L) }
            let create = row(SBRowView.Look(icon: SidebarIcons.folder, label: "Create new"), id: "sb-create-folder")
            create.iconPlus = true
            create.onClick = { [weak self] _ in self?.makeFolder() }
            place(create)
        }
        L.y += 4
        list.contentHeight = L.y
        list.guides = L.guides
        list.dropping = dropping
        list.needsLayout = true
        rows["sb-head=projects"] = projectsHead
    }

    /// A project's row, then (open) its children and their More.
    private func projectRows(_ id: String, x: CGFloat, _ L: ListLayout) {
        guard let at = tree[id] else { return }
        let node = at.node
        let kids = node.children.map(\.id)
        let open = plan.opened.contains(id)
        let here = id == input.hereId
        let inBranch = input.hereId.flatMap { tree[$0]?.path.contains(id) } ?? false
        let holds = !here && inBranch && !open
        let n = at.level == 2 ? SidebarModel.shortcutOf(input.roots, id) : 0
        let canAdd = at.level < SidebarModel.MAX_DEPTH
        let renamingHere = renaming == id

        let r = row(SBRowView.Look(icon: SidebarIcons.workspace, label: node.name, indent: at.level > 2, active: here, holds: holds, faint: Names.isUntitled(node.name), flash: input.flashId == id),
                    id: "sb-project-row=\(id)")
        r.setAccessibilityLabel(n > 0 ? "\(node.name), Ctrl+\(n)" : node.name)
        if n == 0 { r.toolTip = node.name }
        r.level = at.level

        // the tools: + (on hover), the count, the chevron
        let addSlot = Slot(width: 22)
        if canAdd && !renamingHere {
            let add = addButton("Create project within \(node.name)", id: "sb-new-child=\(id)") { [weak self] _ in self?.create(id) }
            add.revealOnHover = true
            addSlot.child = add
        }
        let countSlot = Slot(width: 22)
        if let summary = counts[id], summary.total > 0 {
            let count = SBCountView(summary: summary, pill: false)
            count.setAccessibilityIdentifier("sb-count=\(id)")
            count.frame.size = count.fitting
            countSlot.child = count
        }
        let chevSlot = Slot(width: 18)
        if !kids.isEmpty {
            let chevron = chevronButton(open: open, label: open ? "Fold \(node.name)" : "Open \(node.name)", id: "sb-chevron=\(id)") { [weak self] button in self?.chevronPress(id, element: button) }
            chevron.revealOnHover = at.level == 2 && !inBranch
            chevSlot.child = chevron
            rows["sb-chevron=\(id)"] = chevron
        }
        r.accessories = [addSlot, countSlot, chevSlot]
        r.accessoryGap = 5
        if renamingHere { r.renameField = renameField(node.name) { [weak self] name in if let name { self?.context.actions.renameWorkspace(id, name) } } }
        r.onClick = { [weak self] _ in guard let self, self.renaming != id else { return }; self.go(id) }
        r.onDoubleClick = { [weak self] _ in self?.startRename(id) }
        r.onContextMenu = { [weak self] event in self?.projectMenu(id, at: event) }
        r.onHover = { [weak self] view, inside, event in
            guard let self else { return }
            guard inside else { self.leaveFly(); self.showTip(nil); return }
            // over its + or chevron: no card, no tooltip
            if let event, let hit = view.hitTest(view.superview?.convert(event.locationInWindow, from: nil) ?? .zero), hit !== view, hit is SBIconButton {
                if self.flyout != nil { self.leaveFly() } else { self.holdFly() }
                if n > 0 { self.showTip(nil) }
                return
            }
            if !kids.isEmpty && !open && (self.panel == nil || self.panel?.kind == "project") && self.renaming != id { self.wantFly(id, element: view) }
            else if let fly = self.flyout, fly.id != id { self.leaveFly() }
            if n > 0 && self.panel == nil { self.showTip(view, kind: "shortcut", n: n) }
        }
        rows["sb-project-row=\(id)"] = r
        L.place(r, x, SB.LINE, 0)
        guard open else { return }

        // its children, indented (24 under a level-2 project, 22 deeper), the guide line beside the deepest group
        let shownKids = kids.filter { plan.shown.contains($0) }
        let hiddenKids = kids.filter { !plan.shown.contains($0) }
        let indent: CGFloat = at.level + 1 == 3 ? 24 : 22
        let top = L.y
        for kid in shownKids { projectRows(kid, x: x + indent, L) }
        if !hiddenKids.isEmpty {
            let more = moreRow(id: "sb-more=\(id)", count: SidebarModel.summaryOf(tree, input.entries, hiddenKids), open: panel?.kind == "siblings" && panel?.key == id, indent: true)
            more.onClick = { [weak self, weak more] _ in guard let self, let more else { return }; self.togglePanel("siblings", element: more, key: id, parentId: id) }
            rows["sb-more=\(id)"] = more
            L.place(more, x + indent, SB.LINE, 0)
        }
        if plan.guide == id {
            // .sb-kids[data-guide]::before: 15.5 in from the group (10.5 at level 4), 2 from its top and bottom
            L.guides.append(CGRect(x: x + (at.level + 1 == 4 ? 10.5 : 15.5), y: top + 2, width: 1, height: max(0, L.y - top - 4)))
        }
    }

    /// A folder of Sources: its row, then (open) its rows, More, and "+ Note" when this project's is empty.
    private func folderGroup(key: String, name: String, list: [LibraryRow], folder: AppState.Folder?, defaultOpen: Bool, _ L: ListLayout) {
        let storeKey = folder.map { "folder:\($0.id)" } ?? key
        let open = isOpen(storeKey, defaultOpen)
        let tag = folder?.id ?? "project"
        let groupTop = L.y
        let r = row(SBRowView.Look(icon: SidebarIcons.folder, label: name), id: "sb-folder=\(tag)")
        r.toolTip = name
        r.expanded = open
        let add = addButton("Add sources to \(name)", id: "sb-folder-add=\(tag)") { [weak self] button in self?.addTo(button, folder: folder) }
        add.revealOnHover = true
        rows["sb-trigger=add:\(tag)"] = add
        let chevron = chevronButton(open: open, label: "\(open ? "Collapse" : "Expand") \(name)", id: "sb-folder-chevron=\(tag)") { [weak self] _ in self?.toggleStored(storeKey, defaultOpen) }
        r.accessories = open ? [add, chevron] : [chevron]
        r.accessoryGap = 2
        if let folder, renaming == folder.id { r.renameField = renameField(folder.name) { [weak self] value in if let value { self?.renameFolder(folder.id, value) } } }
        r.onClick = { [weak self] _ in guard let self, !(folder != nil && self.renaming == folder!.id) else { return }; self.toggleStored(storeKey, defaultOpen) }
        if let folder {
            r.onDoubleClick = { [weak self] _ in self?.startRename(folder.id) }
            r.onContextMenu = { [weak self] event in self?.folderMenu(folder, event: event) }
        }
        rows["sb-folder=\(tag)"] = r
        L.place(r, 0, SB.LINE, 0)
        if open {
            let (shown, more) = SidebarModel.folderRows(list)
            for source in shown { sourceRow(source, folder: folder, L) }
            if more {
                let m = moreRow(id: "sb-more=\(tag)", count: nil, open: panel?.kind == "sources" && panel?.key == tag)
                m.onClick = { [weak self, weak m] _ in guard let self, let m else { return }; self.togglePanel("sources", element: m, key: tag, folderId: folder?.id) }
                rows["sb-more=\(tag)"] = m
                L.place(m, 24, SB.LINE, 0)
            }
            if folder == nil && list.isEmpty && input.canNewNote {
                let plusNote = row(SBRowView.Look(style: .plain, label: "+ Note", size: SB.indentSize, color: Palette.fnt, padLeft: 10), id: "sb-plus-note")
                plusNote.onClick = { [weak self] _ in self?.newNote(folderId: nil) }
                rows["sb-plus-note"] = plusNote
                L.place(plusNote, 24, SB.LINE, 0)
            }
        }
        let group = SBView(frame: CGRect(x: 0, y: groupTop, width: L.width, height: L.y - groupTop))
        L.list.addSubview(group, positioned: .below, relativeTo: nil)
        group.setAccessibilityIdentifier("sb-folder-group=\(tag)")
        rows["sb-folder-group=\(tag)"] = group
    }

    private func sourceRow(_ source: LibraryRow, folder: AppState.Folder?, _ L: ListLayout) {
        let a = context.actions
        // No icon beside a file in a folder (2026-10-15, Hudson: "get rid of these icons next to the files within folders").
        let r = row(SBRowView.Look(icon: nil, label: source.name, active: source.id == input.activeRowId, faint: Names.isUntitled(source.name), flash: input.flashId == source.id),
                    id: "sb-source=\(source.id)")
        r.toolTip = source.name
        if renaming == source.id {
            r.renameField = renameField(source.name) { name in if let name { a.renameRow(source, name) } }
        } else if let folder {
            let minus = rowAction("Remove from \(folder.name)", id: "sb-remove=\(source.id)") { [weak self] _ in self?.peek.drop(); self?.removeFromFolder(folder.id, source.id) }
            r.accessories = [minus]
        } else if input.inRail.contains(source.id) {
            let minus = rowAction("Remove from this project", id: "sb-remove=\(source.id)") { [weak self] _ in self?.peek.drop(); a.removeRow(source) }
            r.accessories = [minus]
        }
        r.dragRow = renaming == source.id ? nil : source
        r.onClick = { [weak self] _ in guard let self, self.renaming != source.id else { return }; self.peek.drop(); a.openRow(source) }
        r.onDoubleClick = { [weak self] _ in self?.peek.drop(); self?.startRename(source.id) }
        r.onContextMenu = { [weak self] event in self?.sourceMenu(source, folder: folder, event: event) }
        r.onHover = { [weak self] view, inside, _ in
            guard let self, let window = view.window else { return }
            if inside {
                if self.renaming != source.id && self.panel == nil && !self.peek.isShowing || (inside && self.peek.peek?.row.id != source.id && self.panel == nil) {
                    self.peek.open(source, rect: FloatingPanel.anchorRect(of: view), edge: FloatingPanel.anchorRect(of: self.root).maxX, in: window)
                }
            } else { self.peek.close() }
        }
        rows["sb-source=\(source.id)"] = r
        L.place(r, 24, SB.LINE, 0)
    }

    /// + on Sources or a folder: the add picker, beside the row; a second press closes it.
    func addTo(_ element: NSView, folder: AppState.Folder?) {
        peek.drop()
        let key = folder?.id ?? "project"
        if let p = panel, p.kind == "add", p.key == key { close(); return }
        open(Panel(kind: "add", key: key, anchor: anchorOf(element), folderId: folder?.id, from: FloatingPanel.anchorRect(of: element)))
    }

    // MARK: the foot

    private func renderFoot() {
        let foot = root.foot
        foot.toggle.look = SBRowView.Look(icon: SidebarIcons.sticky(hidden: input.stickiesHidden), label: input.stickiesHidden ? "Show stickies" : "Hide stickies")
        foot.toggle.toolTip = input.stickiesHidden ? "Bring every sticky back into sight" : "Put every sticky out of sight"
        foot.toggle.setAccessibilityRole(.checkBox)
        foot.toggle.setAccessibilityValue(!input.stickiesHidden)
        foot.toggle.setAccessibilityIdentifier("toggle-post-its=\(input.stickiesHidden ? "hidden" : "shown")")
        foot.trashShown = input.trashFull
        foot.dragging = input.stickyDrag
        rows["sb-foot"] = foot
        rows["sb-trash"] = foot.trash
    }

    // MARK: pieces

    func row(_ look: SBRowView.Look, id: String) -> SBRowView {
        let r = SBRowView(look: look, id: id)
        r.flashDuration = context.timing.flash
        rows[id] = r
        return r
    }

    /// A section's title (Linear's "Your teams"): no icon, quiet, its chevron after it; a press on them folds it.
    func sectionHead(_ label: String, open: Bool, key: String) -> SBRowView {
        let r = row(SBRowView.Look(style: .section, label: label, sectionOpen: open, noHover: true), id: "sb-head=\(key)")
        r.setAccessibilityValue(open)
        r.onClick = { [weak self, weak r] event in
            guard let self, let r else { return }
            let x = r.convert(event.locationInWindow, from: nil).x
            let toggleEnd = r.labelX + textWidth(label, font: r.textFont) + 5 + 13
            if event.window == nil || x <= toggleEnd { self.toggleStored("section:\(key)", true) }
        }
        return r
    }

    func moreRow(id: String, count: AgentSummary?, open: Bool, indent: Bool = false) -> SBRowView {
        let r = row(SBRowView.Look(style: .more, label: "More", indent: indent, active: open), id: id)
        if let count, count.total > 0 {
            let countSlot = Slot(width: 22)
            let c = SBCountView(summary: count, pill: false)
            c.frame.size = c.fitting
            countSlot.child = c
            r.accessories = [Slot(width: 22), countSlot, Slot(width: 18)]
        }
        return r
    }

    func addButton(_ label: String, id: String, action: @escaping (SBIconButton) -> Void) -> SBIconButton {
        let b = SBIconButton(icon: SidebarIcons.plus, size: 15, box: CGSize(width: 22, height: 22), color: Palette.fnt, hoverColor: Palette.ink, hoverFill: SB.addHover, radius: 4, label: label, id: id)
        b.action = { [weak self] button in self?.showTip(nil); action(button) }
        b.onHoverChange = { [weak self] button, on in if on { self?.labelTip(button, label) } else { self?.showTip(nil) } }
        rows[id] = b
        return b
    }

    func chevronButton(open: Bool, label: String, id: String, action: @escaping (SBIconButton) -> Void) -> SBIconButton {
        let b = SBIconButton(icon: stroked(SidebarIcons.chevronDown, 2.4), size: 13, box: CGSize(width: 18, height: 18), color: SB.chev, hoverColor: Palette.gray700, hoverFill: SB.chevHover, radius: 4, label: label, id: id)
        b.rotated = !open
        b.setAccessibilityValue(open)
        b.action = action
        return b
    }

    func rowAction(_ label: String, id: String, action: @escaping (SBIconButton) -> Void) -> SBIconButton {
        let b = SBIconButton(icon: SidebarIcons.minusCircle, size: 15, box: CGSize(width: 22, height: 22), color: Palette.fnt, hoverColor: Palette.ink, hoverFill: SB.addHover, radius: 5, label: label, id: id)
        b.toolTip = label
        b.revealOnHover = true
        b.action = action
        rows[id] = b
        return b
    }

    func renameField(_ initial: String, done: @escaping (String?) -> Void) -> RenameField {
        let field = RenameField(initial: initial, font: Fonts.sans(SB.rowSize))
        field.onDone = { [weak self] name in self?.endRename(); done(name) }
        return field
    }
}

/// Where the next row of the list goes.
final class ListLayout {
    let list: SidebarListView
    let width: CGFloat
    var y: CGFloat = 4
    var guides: [CGRect] = []
    init(list: SidebarListView, width: CGFloat) { self.list = list; self.width = width }
    func place(_ view: NSView, _ x: CGFloat, _ height: CGFloat, _ gap: CGFloat) {
        view.frame = CGRect(x: x, y: y, width: max(0, width - x), height: height)
        list.addSubview(view)
        y += height + gap
    }
}

/// A fixed-width place at a row's right that centres what it holds (styles.css .sb-slot-*).
final class Slot: SBView {
    var child: NSView? { didSet { oldValue?.removeFromSuperview(); if let c = child { addSubview(c) }; needsLayout = true } }
    init(width: CGFloat) { super.init(frame: CGRect(x: 0, y: 0, width: width, height: 22)) }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        guard let c = child else { return }
        c.frame.origin = CGPoint(x: (bounds.width - c.frame.width) / 2, y: (bounds.height - c.frame.height) / 2)
    }
}

/// The head's rename box: white, 1px #c9c9c9, radius 6, padding 0 8.
final class RenameBox: SBView {
    var field: NSTextField?
    override func draw(_ dirtyRect: NSRect) {
        fill(bounds, .white, radius: 6)
        Palette.bd2.setStroke()
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6); p.lineWidth = 1; p.stroke()
    }
    override func layout() { super.layout(); field?.frame = CGRect(x: 8, y: (bounds.height - 20) / 2, width: bounds.width - 16, height: 20) }
}
