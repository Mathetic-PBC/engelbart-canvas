import AppKit
import EngelbartCore
import EngelbartUI

// The Stage's drawing, its address field, find, the keys and the menus (Stage.jsx, from `return (` and the handlers).

extension StageController: NSTextFieldDelegate {
    func wireViews() {
        strip.onSelect = { [weak self] id in self?.select(id) }
        strip.onClose = { [weak self] id in self?.closeTab(id) }
        strip.onNew = { [weak self] in self?.newTab() }
        strip.onFull = { [weak self] in self?.onFull?() }
        strip.onMenu = { [weak self] id, point in self?.tabMenu(id, at: point) }
        address.back.onClick = { [weak self] in self?.goBack() }
        address.forward.onClick = { [weak self] in self?.goForward() }
        address.reload.onClick = { [weak self] in self?.reloadFront() }
        address.field.delegate = self
        address.field.onFocus = { [weak self] in self?.typing = true; self?.renderAddress() }
        address.save.onClick = { [weak self] in self?.saveClicked() }
        address.undo.onClick = { [weak self] in
            guard let self, let removed = self.boxRemoved else { return }
            self.boxTimer?.invalidate(); self.boxRemoved = nil; self.renderAddress()
            Task { @MainActor in _ = await self.browser.undoBox(removed.id) }
        }
        address.boxButton.target = self
        address.boxButton.action = #selector(boxPressed)
        address.more.onClick = { [weak self] in self?.moreMenu() }
        let crumbClick = NSClickGestureRecognizer(target: self, action: #selector(crumbClicked))
        address.crumb.addGestureRecognizer(crumbClick)
        list.onChoose = { [weak self] row in self?.choose(row) }
        list.onHover = { [weak self] i in self?.arrowed = true; self?.pick = i; self?.list.pick = i }
        list.glyphFor = { [weak self] row in self?.glyphKey(for: row) ?? "website" }
        findCard.onText = { [weak self] text in self?.findText = text; self?.runFind(text, 0) }
        findCard.onStep = { [weak self] step in guard let self else { return }; self.runFind(self.findText, step) }
        findCard.onClose = { [weak self] in self?.closeFind() }
        sectionsMenu.onPick = { [weak self] i in self?.pickSection(i) }
        sectionsMenu.onClose = { [weak self] in self?.closeSections() }
    }

    @objc func boxPressed() { browser.startBox(tab.id, mode: "button") }
    @objc func crumbClicked() { typing = true; renderAddress(); focusAddress() }

    // ---------------------------------------------------------------------------------------------------- layout

    func layoutAll() {
        let w = root.bounds.width
        strip.frame = NSRect(x: 0, y: 0, width: w, height: 40)
        address.frame = NSRect(x: 0, y: 40, width: w, height: 47)
        content.frame = NSRect(x: 0, y: 87, width: w, height: max(0, root.bounds.height - 87))
        if !list.isHidden && list.superview != nil {
            list.frame = NSRect(x: 92, y: 40 + 44, width: max(100, w - 102), height: list.fittingHeight)
        }
        if let card = saveCard { card.frame.origin = NSPoint(x: max(10, w - 10 - card.frame.width), y: 40 + 44) }
        layoutContent()
    }

    /// Where the page goes: the content area, under the find band while finding, a device's width centred on grey; and
    /// never over the window's resize strips (6 pt off its right and bottom edges).
    func slotRect() -> NSRect {
        var r = content.bounds
        if finding && isPageTab { r.origin.y += 54; r.size.height -= 54 }
        let width: CGFloat = device == "custom" ? CGFloat(Double(customW) ?? 390) : (Self.devices.first { $0.id == device }?.w ?? 0)
        if width > 0 && width < r.width { r.origin.x += ((r.width - width) / 2).rounded(); r.size.width = width }
        if let window = content.window {
            let inWindow = content.convert(r, to: nil)
            let contentWidth = window.contentLayoutRect.width
            let rightLimit = contentWidth - Self.windowEdge, bottomLimit = Self.windowEdge
            var adjusted = inWindow
            if adjusted.maxX > rightLimit { adjusted.size.width = max(1, rightLimit - adjusted.minX) }
            if adjusted.minY < bottomLimit { let cut = bottomLimit - adjusted.minY; adjusted.origin.y += cut; adjusted.size.height = max(1, adjusted.height - cut) }
            r = content.convert(adjusted, from: nil)
        }
        return r.integral
    }

    func layoutContent() {
        let b = content.bounds
        pdfView?.viewer.view.frame = b
        fileView?.viewer.view.frame = b
        if let plain { plain.view.frame = isPageTab ? slotRect() : b }
        if finding { findCard.frame = NSRect(x: max(14, b.width - 14 - 360), y: 10, width: min(360, b.width - 28), height: 34) }
        if !sectionsMenu.isHidden && sectionsMenu.superview != nil { sectionsMenu.frame = NSRect(x: max(14, b.width - 14 - 360), y: finding ? 52 : 10, width: min(360, b.width - 28), height: 34) }
        if showing { browser.show(tab.id, slotRect()) }
    }

    // ---------------------------------------------------------------------------------------------------- render

    /// Everything drawn from the state, as React would.
    func render() {
        guard isViewLoaded else { return }
        root.isHidden = !visible
        if tab.restore != nil && !tab.restoreOpening { openRestored() }
        strip.tabs = tabs.map { StripTab(id: $0.id, title: titleOf($0), place: placeOf($0), glyph: glyphKey(for: $0), blank: $0.url == "about:blank" && $0.pdf == nil && $0.file == nil && $0.restore == nil) }
        strip.activeId = tab.id
        if !typing && view.window?.firstResponder !== address.field.currentEditor() { draft = shownDraft }
        renderAddress()
        renderContent(force: false)
        renderFind()
        tellHost()
        keepStage()
        pendingFind()
        previewClock()
        retryLocal()
    }

    func tellHost() {
        guard let host else { return }
        let page = savable ? StagePage(input: pageInput ?? "", title: pageTitle.isEmpty ? StageAddress.stripScheme(pageInput ?? "") : pageTitle,
                                       bytes: (pdf?.rowId == nil && SRx("^https?:", "i").test(pdf?.url ?? "")) ? pdf?.bytes : nil, tabId: tab.id,
                                       webPage: isPageTab && SRx("^https?:", "i").test(pageInput ?? "")) : nil
        let places = tabs.map { $0.file?.path ?? ($0.pdf?.input.isEmpty == false ? $0.pdf!.input : nil) ?? (BrowserRules.isFileUrl($0.url) ? $0.url : "") }.filter { !$0.isEmpty }
        let key = "\(page?.input ?? "")|\(page?.title ?? "")|\(page?.tabId ?? "")|\(page?.bytes?.count ?? -1)|\(tab.item ?? "")|\(places.joined(separator: "\n"))"
        if key == lastHost { return }
        lastHost = key
        host.stagePageChanged(page)
        host.stageFrontChanged(tab.item)
        host.stageTabsChanged(places)
    }

    func renderAddress() {
        guard isViewLoaded else { return }
        address.typing = typing
        if address.field.stringValue != draft && !(typing && address.field.currentEditor() != nil && address.field.stringValue == draft) { address.field.stringValue = draft }
        address.glyph.image = KindIcons.kind(glyphKey(for: tab)).icon.image(size: 14)
        let canBack = pdf != nil ? (pdf!.under != "about:blank" || tab.web?.url.isEmpty == false) : isPageTab ? (tab.web?.canGoBack ?? false) : tab.web?.url.isEmpty == false
        let canForward = pdf == nil && (tab.pdfForward != nil || (isPageTab && (tab.web?.canGoForward ?? false)))
        address.back.setTitle("←", size: 14, color: canBack ? Palette.ink : Palette.bd2)
        address.forward.setTitle("→", size: 14, color: canForward ? Palette.ink : Palette.bd2)
        let loading = isPageTab && (tab.web?.loading ?? false) && failed == nil
        address.reload.setTitle(loading ? "×" : "↻", size: 14, color: Palette.mut)
        address.reload.setAccessibilityLabel(loading ? "Stop" : "Reload")
        let state = save != nil && savable ? save!.state : nil
        address.showsSave = state != nil
        address.showsCrumb = (state == .made || state == .madeSaved) && save?.crumb != nil
        address.crumb.stringValue = save?.crumb ?? ""
        if let state {
            let text: String
            switch state {
            case .made: text = save?.busy == true ? "Saving…" : "⊞ Save"
            case .madeSaved: text = "✓ Saved"
            default: text = StageModel.saveLabel[state] ?? ""
            }
            let quiet = state == .here || state == .madeSaved
            address.save.setTitle(text, size: 12, weight: 500, color: quiet ? Palette.fnt : (saveCard != nil ? Palette.ink : Palette.mut))
            address.save.isEnabled = !(state == .madeSaved || (state == .made && save?.busy == true))
            address.save.wash = quiet ? nil : Palette.hov
        }
        let boxable = isPageTab && failed == nil && wait == nil && tab.web != nil && (SRx("^https?:", "i").test(tab.web!.url) || BrowserRules.isFileUrl(tab.web!.url)) && !StageAddressKey.isPreviewAddress(tab.web!.url)
        address.showsBox = boxable
        address.setBoxing(boxing == tab.id)
        address.showsToast = boxRemoved?.id == tab.id
        if typing { showList() } else { hideList() }
        address.needsLayout = true
    }

    /// What the content area shows, rebuilt only when what it is changed.
    func renderContent(force: Bool) {
        guard isViewLoaded else { return }
        content.fill = pdf != nil ? Palette.panel : Palette.panel2
        // the pdf viewer
        if let pdf, let bytes = pdf.bytes, let marks = pdf.marks {
            let key = "\(tab.id):\(pdf.seq)"
            if pdfView?.key != key, let host {
                pdfView?.viewer.view.removeFromSuperview()
                let tabId = tab.id, seq = pdf.seq
                let sectionsOn = !(tab.sections ?? []).isEmpty
                let asks = pendingAsks.filter { p in pdf.rowId != nil ? p["rowId"]?.string == pdf.rowId : (p["rowId"] == nil || p["rowId"] == .null) && p["url"]?.string == pdf.url }
                let request = StagePDFRequest(
                    tabId: tabId, bytes: bytes, marks: marks, target: tab.pendingFind, targetTo: tab.pendingTo, targetPage: tab.pendingPage,
                    initialSection: sectionsOn && tab.activeSection >= 0 && tab.activeSection < tab.sections!.count ? tab.sections![tab.activeSection] : nil,
                    viewState: pdf.view, rowId: pdf.rowId, url: pdf.url, name: pdf.name, pendingAsks: asks,
                    onView: { [weak self] v in self?.update(tabId) { t in if t.pdf?.seq == seq { t.pdf?.view = v } } },
                    onTarget: { [weak self] text, result in self?.landed(tabId, text, result) },
                    onFind: { [weak self] result in guard let self, self.finding else { return }; self.matches = result; self.renderFind() },
                    onMarksChange: { [weak self] marks in self?.marksChanged(tabId, seq: seq, marks) },
                    onAsk: { [weak self] ask in self?.askFromPaper(ask) },
                    onOpenLink: { [weak self] href in guard let self else { return }; if !(self.host?.openCited(href) ?? false) { self.openInput(href, newTab: true) } })
                let viewer = host.makePDFView(request)
                content.addSubview(viewer.view, positioned: .below, relativeTo: nil)
                pdfView = (key, viewer)
            }
        } else if let current = pdfView {
            current.viewer.view.removeFromSuperview(); pdfView = nil
        }
        // a file drawn here
        if let file = drawnFile, file.kind != .folder, file.kind != .unsupported, file.kind != .error, file.kind != .loading {
            let key = "\(tab.id):\(file.kind.rawValue):\(file.path):\(file.text?.utf16.count ?? file.bytes?.count ?? 0)"
            if fileView?.key != key {
                fileView?.viewer.view.removeFromSuperview()
                let viewer: StageFileView
                switch file.kind {
                case .md:
                    let v = TextFileView(attributed: TextFileView.markdown(file.text ?? ""), inset: NSSize(width: 24, height: 24), maxWidth: 65 * 8.2)
                    v.onLink = { [weak self] href in self?.openInput(href) }
                    viewer = v
                case .table: viewer = TableFileView(text: file.text ?? "", delimiter: file.delimiter ?? ",", truncated: file.truncated)
                case .image: viewer = ImageFileView(bytes: file.bytes ?? Data(), name: file.name)
                default: viewer = TextFileView(attributed: TextFileView.plain(file.text ?? ""), inset: NSSize(width: 16, height: 14), maxWidth: nil)
                }
                content.addSubview(viewer.view, positioned: .below, relativeTo: nil)
                fileView = (key, viewer)
                layoutContent()
                (viewer as? TextFileView)?.relayout()
            }
        } else if let current = fileView { current.viewer.view.removeFromSuperview(); fileView = nil }
        // what cannot be drawn, the blank tab, a wait, a failure
        let plainKey: String?
        var make: (() -> NSView)?
        if let pdf, pdf.bytes == nil || pdf.marks == nil {
            plainKey = "pdf:\(pdf.seq):\(pdf.error)"
            make = { pdf.error.isEmpty ? PlainView(title: "") : PlainView(title: StageAddress.stripScheme(pdf.input.isEmpty ? pdf.url : pdf.input), detail: pdf.error, error: true) }
        } else if let file = drawnFile, [.folder, .unsupported, .error, .loading].contains(file.kind) {
            plainKey = "file:\(tab.id):\(file.kind.rawValue):\(file.path)"
            make = {
                switch file.kind {
                case .error: return PlainView(title: file.path, detail: file.message ?? "", error: true)
                case .loading: return PlainView(title: "")
                default: return PlainView(title: file.name, detail: file.path)
                }
            }
        } else if isBlank {
            plainKey = "blank"
            make = { [weak self] in self?.blankView() ?? NSView() }
        } else if isPageTab, let w = wait {
            let name = StageModel.previewName(previewRow?.name)
            plainKey = "wait:\(tab.id):\(w.rawValue)"
            make = { [weak self] in
                guard let self else { return NSView() }
                if w == .waking { return PlainView(title: name.isEmpty ? "Waking the sandbox…" : "Waking \(name)'s sandbox…", detail: "It was asleep — this can take a few seconds.", prose: true) }
                var actions: [(String, Bool, () -> Void)] = [("Retry", true, { [weak self] in self?.retryPreview() })]
                if let row = self.previewRow { actions.append(("Build details", false, { [weak self] in guard let self else { return }; self.host?.openBuildDetails(row, from: self.content) })) }
                return PlainView(title: name.isEmpty ? "Couldn't load the preview" : "Couldn't load \(name)'s preview", detail: "The sandbox didn't answer. It may still be starting, or its app has stopped.", prose: true, actions: actions)
            }
        } else if let failed {
            plainKey = "failed:\(tab.id):\(failed.code):\(failed.url)"
            make = { [weak self] in
                PlainView(title: StageAddress.stripScheme(failed.url.isEmpty ? self?.tab.url : failed.url), detail: failed.description.isEmpty ? "error \(failed.code)" : failed.description,
                          actions: [("Retry", false, { [weak self] in guard let self else { return }; self.browser.command(self.tab.id, "reload") })])
            }
        } else if pdf == nil && drawnFile == nil && !isPageTab && kind.kind == .sandbox {
            plainKey = "sandbox:\(kind.name ?? "")"
            make = { [kind] in PlainView(title: kind.name ?? "") }
        } else { plainKey = nil }
        if plain?.key != plainKey || force {
            plain?.view.removeFromSuperview(); plain = nil
            if let plainKey, let make { let v = make(); content.addSubview(v, positioned: .below, relativeTo: nil); plain = (plainKey, v) }
        }
        if showing { browser.show(tab.id, slotRect()) } else { browser.hide() }
        // the sections menu over a pdf with a guide's sections
        let sectionsOn = pdf != nil && !(tab.sections ?? []).isEmpty && pdfView != nil
        if sectionsOn {
            sectionsMenu.show(tab.sections ?? [], active: tab.activeSection)
            if sectionsMenu.superview !== content { content.addSubview(sectionsMenu, positioned: .above, relativeTo: nil) }
            sectionsMenu.isHidden = false
        } else { sectionsMenu.isHidden = true }
        if visible, isPageTab, let url = tab.web?.url ?? Optional(tab.url) { host?.previewTouch(url, visible: true) }
        layoutContent()
    }

    func blankView() -> NSView {
        let v = FlippedView(); v.fill = Palette.panel2
        let title = makeLabel("Engelbart", size: 34, weight: 500)
        title.attributedStringValue = NSAttributedString(string: "Engelbart", attributes: [.font: Fonts.sans(34, weight: 500), .foregroundColor: Palette.ink, .kern: -0.4])
        let choose = TextButton("Choose a file…", size: 13, weight: 500, color: Palette.ink, radius: 8)
        choose.baseFill = Palette.panel; choose.layer?.borderWidth = 1; choose.layer?.borderColor = Palette.bd.cgColor
        choose.onClick = { [weak self] in self?.chooseFiles() }
        let stack = NSStackView(views: [title, choose]); stack.orientation = .vertical; stack.spacing = 22
        stack.translatesAutoresizingMaskIntoConstraints = false
        choose.translatesAutoresizingMaskIntoConstraints = false
        choose.heightAnchor.constraint(equalToConstant: 32).isActive = true
        choose.widthAnchor.constraint(equalToConstant: choose.intrinsicContentSize.width + 28).isActive = true
        v.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: v.centerXAnchor), stack.centerYAnchor.constraint(equalTo: v.centerYAnchor, constant: -48)])
        return v
    }

    // ------------------------------------------------------------------------------------------------ titles, glyphs

    func titleOf(_ t: StageTab) -> String {
        if let r = t.restore { let row = r.item.flatMap { id in host?.library().first { $0.id == id } }; let title = r.title.isEmpty ? (row?.name ?? StageAddress.stripScheme(r.address ?? "")) : r.title; return title.isEmpty ? "New tab" : title }
        if let row = t.row { return row.name }
        if let pdf = t.pdf { return pdf.name }
        if let name = t.file?.name, !name.isEmpty { return name }
        if t.url == "about:blank" { return "New tab" }
        if Self.isPage(StageAddress.kindOf(t.url)), let title = t.web?.title, !title.isEmpty { return title }
        return StageAddress.stripScheme(t.url)
    }

    func placeOf(_ t: StageTab) -> String {
        if let r = t.restore {
            let row = r.item.flatMap { id in host?.library().first { $0.id == id } }
            return StageModel.tabPlace(row.map { $0.url ?? $0.path ?? $0.folderPath ?? "" } ?? r.address ?? "")
        }
        if t.url == "about:blank" && t.pdf == nil && t.file == nil { return "new tab" }
        return StageModel.tabPlace(t.pdf.map { $0.input.isEmpty ? $0.url : $0.input } ?? t.file?.path ?? (t.web?.url.isEmpty == false ? t.web!.url : t.url))
    }

    static let imageExt = SRx(#"\.(png|jpe?g|gif|webp|heic|heif|svg)$"#, "i")

    /// A tab's glyph: what the library would call it (Stage.jsx glyphItem).
    func glyphKey(for t: StageTab) -> String {
        if let r = t.restore {
            if let item = r.item { return StageKind.kindKey(host?.library().first { $0.id == item } ?? StageRow(id: "", name: "", type: "website")) }
            let a = r.address ?? ""
            if SRx(#"\.pdf$"#, "i").test(a) { return "pdf" }
            var g = StageTab(); if a.hasPrefix("/") { g.file = StageFile(kind: .text, path: a, name: "") } else { g.url = a }
            return glyphKey(for: g)
        }
        if let row = t.row { return StageKind.kindKey(row) }
        if t.pdf != nil { return "pdf" }
        if let path = t.file?.path, !path.isEmpty {
            if Self.imageExt.test(path) { return "image" }
            let ext = (path as NSString).pathExtension.lowercased()
            if ["md", "markdown"].contains(ext) { return "md" }
            if ["doc", "docx"].contains(ext) { return "docx" }
            if ["csv", "tsv", "json", "jsonl"].contains(ext) { return "data" }
            if ["html", "htm"].contains(ext) { return "html" }
            if t.file?.kind == .folder { return "folder" }
            return "md"
        }
        return StageAddress.kindOf(t.url).kind == .disk ? "html" : "website"
    }

    func glyphKey(for row: StageModel.AddressRow) -> String {
        switch row {
        case .item(let r, _): return StageKind.kindKey(r)
        case .search: return "search"
        case .disk: return "disk"
        case .place(let input):
            var g = StageTab(); g.url = StageAddress.kindOf(input).url ?? "about:blank"
            if SRx("^[.~/]").test(input) { g.file = StageFile(kind: .text, path: input, name: "") }
            return glyphKey(for: g)
        }
    }

    // --------------------------------------------------------------------------------------- back, forward, reload

    func goBack() {
        let t = tab
        if let pdf = t.pdf {
            guard pdf.under != "about:blank" || t.web?.url.isEmpty == false else { return }
            update(t.id) { x in x.pdfForward = x.pdf; x.pdf = nil; x.url = pdf.under != "about:blank" ? pdf.under : (x.web?.url.isEmpty == false ? x.web!.url : "about:blank") }
            render()
        } else if isPageTab { browser.command(t.id, "back") }
        else if let url = t.web?.url, !url.isEmpty { update(t.id) { $0.file = nil; $0.url = url }; render() }
    }

    func goForward() {
        if let fwd = tab.pdfForward { update(tab.id) { $0.pdf = fwd; $0.pdfForward = nil }; render() }
        else if pdf == nil && isPageTab && (tab.web?.canGoForward ?? false) { browser.command(tab.id, "forward") }
    }

    func reloadFront() {
        let t = tab
        if let pdf = t.pdf {
            if pdf.rowId != nil, let row = t.row { showRow(t.id, row) }
            else if !pdf.loading && SRx("^https?:", "i").test(pdf.url) { load(t.id, pdf.url) }
            else if BrowserRules.isFileUrl(pdf.url) { readPath(t.id, StageAddress.stripScheme(pdf.url), rowId: nil) }
        } else if isPageTab { browser.command(t.id, (t.web?.loading ?? false) && failed == nil ? "stop" : "reload") }
        else if let path = t.file?.path { readPath(t.id, path, rowId: t.item) }
    }

    /// A local server that is not up yet: knock every 2 s while its tab is in front.
    func retryLocal() {
        retryTimer?.invalidate()
        guard visible, kind.kind == .local, let failed, failed.code == Self.errConnectionRefused else { return }
        let id = tab.id
        retryTimer = Timer.scheduledTimer(withTimeInterval: Self.retryLocalSeconds, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.browser.command(id, "reload") } }
    }

    /// A preview's first page: the wait starts when its tab is in front, a clock runs while it lasts, and a failed load
    /// is tried again every 3 s, never over one still on its way.
    func previewClock() {
        guard previewRow != nil, !(tab.web?.drawn ?? false) else { waitTimer?.invalidate(); waitTimer = nil; return }
        if waits[tab.id] == nil { waits[tab.id] = Date().timeIntervalSince1970 * 1000 }
        guard waitTimer == nil, wait != .failed, visible else { return }
        waitTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.now = Date().timeIntervalSince1970 * 1000
                if self.wait == .waking, self.failed != nil, !(self.tab.web?.loading ?? false), self.now - (self.lastWakeRetry) >= StageModel.wakeRetryMs {
                    self.lastWakeRetry = self.now
                    self.browser.command(self.tab.id, "reload")
                }
                if self.wait != .waking { self.waitTimer?.invalidate(); self.waitTimer = nil }
                self.renderContent(force: false)
            }
        }
    }

    func retryPreview() {
        waits[tab.id] = Date().timeIntervalSince1970 * 1000
        now = waits[tab.id]!
        let target = failed?.url ?? (tab.web?.url.isEmpty == false ? tab.web!.url : tab.url)
        if !target.isEmpty && !SRx("^about:", "i").test(target) { load(tab.id, target) }
        render()
    }

    // ------------------------------------------------------------------------------------------- the address field

    var query: String { typing && draft != shownDraft ? JSStr.trim(draft) : "" }

    func showList() {
        let rows = StageModel.stageRows(query: query, library: host?.library() ?? [], inRail: { [weak self] id in self?.host?.inRail(id) ?? false },
                                        found: found.flatMap { $0.input == query ? .some($0.row) : nil })
        list.rows = rows
        list.pick = min(pick, max(0, rows.count - 1))
        if list.superview !== root { root.addSubview(list, positioned: .above, relativeTo: nil) }
        list.isHidden = rows.isEmpty
        layoutAll()
    }

    func hideList() { list.isHidden = true }

    public func controlTextDidChange(_ obj: Notification) {
        guard (obj.object as? NSTextField) === address.field else { return }
        draft = address.field.stringValue
        typing = true
        pick = 0; arrowed = false
        lookup()
        renderAddress()
    }

    public func controlTextDidEndEditing(_ obj: Notification) {
        guard (obj.object as? NSTextField) === address.field else { return }
        typing = false
        if JSStr.trim(draft).isEmpty { draft = shownDraft }
        renderAddress()
    }

    /// A typed place is looked up in the library 120 ms after the last key.
    func lookup() {
        lookupTask?.cancel()
        let q = query
        guard !q.isEmpty, StageModel.looksLikePlace(q) else { found = nil; return }
        lookupTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled, let answer = await host?.lookupLibraryItem(q), !Task.isCancelled else { return }
            found = (q, answer.row)
            if typing { showList() }
        }
    }

    public func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard control === address.field else { return false }
        let rows = list.rows
        switch selector {
        case #selector(NSResponder.moveDown(_:)): arrowed = true; pick = (pick + 1) % max(1, rows.count); list.pick = pick; return true
        case #selector(NSResponder.moveUp(_:)): arrowed = true; pick = (pick - 1 + rows.count) % max(1, rows.count); list.pick = pick; return true
        case #selector(NSResponder.insertNewline(_:)):
            // with nothing typed and nothing picked, Enter goes to the address again (a reload)
            if query.isEmpty && !arrowed { if !JSStr.trim(draft).isEmpty { reloadFront() }; leaveAddress(); return true }
            if let row = pick < rows.count ? rows[pick] : rows.first { choose(row) }
            return true
        case #selector(NSResponder.cancelOperation(_:)): draft = shownDraft; leaveAddress(); return true
        default: return false
        }
    }

    func leaveAddress() { typing = false; view.window?.makeFirstResponder(nil); renderAddress() }

    func choose(_ row: StageModel.AddressRow) {
        switch row {
        case .disk: chooseFiles()
        case .item(let r, _): leaveAddress(); openRow(r)
        case .place(let input), .search(let input):
            leaveAddress()
            update(tab.id) { $0.sections = nil; $0.activeSection = -1 } // somewhere else: not the paper the guide's sections are in
            let id = tab.id
            Task { @MainActor in await navigate(id, input) }
        }
    }

    func focusAddress() {
        view.window?.makeFirstResponder(address.field)
        address.field.currentEditor()?.selectAll(nil)
    }

    // ------------------------------------------------------------------------------------------------------- save

    func saveClicked() {
        guard let save else { return }
        switch save.state {
        case .made: Task { @MainActor in try? await save.onSave("", true) }
        case .none:
            if saveCard != nil { closeSaveCard(); return }
            let card = SaveCardView(title: pageTitle.isEmpty ? StageAddress.stripScheme(pageInput ?? "") : pageTitle)
            card.onSave = { name, here in try await save.onSave(name, here) }
            card.onClose = { [weak self] in self?.closeSaveCard() }
            root.addSubview(card, positioned: .above, relativeTo: nil)
            saveCard = card
            layoutAll()
            view.window?.makeFirstResponder(card.name)
            card.name.currentEditor()?.selectAll(nil)
            outsideMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, let card = self.saveCard else { return event }
                let p = card.convert(event.locationInWindow, from: nil)
                let onButton = self.address.save.bounds.contains(self.address.save.convert(event.locationInWindow, from: nil))
                if !card.bounds.contains(p) && !onButton { self.closeSaveCard() }
                return event
            }
        case .lib: Task { @MainActor in try? await save.onLink() }
        default: break
        }
        renderAddress()
    }

    func closeSaveCard() {
        saveCard?.removeFromSuperview(); saveCard = nil
        if let m = outsideMonitor { NSEvent.removeMonitor(m); outsideMonitor = nil }
        renderAddress()
    }

    // ---------------------------------------------------------------------------------------------------- menus

    func moreMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let head = NSMenuItem(title: "DEVICE PRESET", action: nil, keyEquivalent: ""); head.isEnabled = false
        head.attributedTitle = NSAttributedString(string: "DEVICE PRESET", attributes: [.font: Fonts.sans(9, weight: 500), .foregroundColor: Palette.fnt, .kern: 1.6])
        menu.addItem(head)
        for d in Self.devices {
            let item = MenuAction.item(d.w > 0 ? "\(d.name)    \(Int(d.w))×\(Int(d.h))" : d.name) { [weak self] in self?.device = d.id; self?.layoutContent() }
            item.state = device == d.id ? .on : .off
            menu.addItem(item)
        }
        let custom = MenuAction.item("Custom width (\(customW))…") { [weak self] in self?.askCustomWidth() }
        custom.state = device == "custom" ? .on : .off
        menu.addItem(custom)
        if (isPageTab && tab.web != nil) || (pdf.map { SRx("^https?:", "i").test($0.url) } ?? false) {
            menu.addItem(.separator())
            let url = pdf?.url ?? (tab.web?.url.isEmpty == false ? tab.web!.url : tab.url)
            menu.addItem(MenuAction.item("Open in default browser") { [weak self] in self?.host?.openExternal(url) })
            if isPageTab { menu.addItem(MenuAction.item("Developer tools") { [weak self] in guard let self else { return }; self.browser.command(self.tab.id, "devtools") }) }
        }
        menu.addItem(.separator())
        menu.addItem(MenuAction.item("Import sign-ins…") { [weak self] in self?.importSignins() })
        menu.popUp(positioning: nil, at: NSPoint(x: address.more.frame.maxX - 240, y: address.more.frame.maxY + 6), in: address)
    }

    func askCustomWidth() {
        let alert = NSAlert()
        alert.messageText = "Custom width"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 80, height: 24)); field.stringValue = customW; field.alignment = .right
        alert.accessoryView = field
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            guard let self, r == .alertFirstButtonReturn else { return }
            self.customW = field.stringValue.filter(\.isNumber)
            self.device = "custom"
            self.layoutContent()
        }
        if let w = view.window { alert.beginSheetModal(for: w, completionHandler: finish) } else { finish(alert.runModal()) }
    }

    func importSignins() {
        if let onImportSignins { onImportSignins(); return }
        ImportSigninsWindow.show(over: view.window, importer: StageSession.shared.cookieImport(userDataDir: Self.appSupport, installedApps: InstalledApps())) { [weak self] url in self?.openInput(url) }
    }

    static var appSupport: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Engelbart Swift") }

    func tabMenu(_ id: String, at point: NSPoint) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let at = tabs.firstIndex { $0.id == id } ?? -1
        menu.addItem(MenuAction.item("Close tab") { [weak self] in self?.closeTab(id) })
        let others = MenuAction.item("Close other tabs") { [weak self] in
            guard let self else { return }
            if id != self.tab.id { self.select(id) }
            for other in self.tabs where other.id != id { self.closeTab(other.id) }
        }
        others.isEnabled = tabs.count >= 2
        menu.addItem(others)
        let right = MenuAction.item("Close tabs to the right") { [weak self] in
            guard let self, let i = self.tabs.firstIndex(where: { $0.id == id }) else { return }
            let rest = Array(self.tabs[(i + 1)...])
            if rest.contains(where: { $0.id == self.tab.id }) { self.select(id) }
            for other in rest { self.closeTab(other.id) }
        }
        right.isEnabled = at >= 0 && at < tabs.count - 1
        menu.addItem(right)
        if let cell = strip.subviews.first(where: { $0 is NSScrollView }) { menu.popUp(positioning: nil, at: cell.convert(point, from: nil), in: cell) } else { menu.popUp(positioning: nil, at: point, in: strip) }
    }
}

// ---------------------------------------------------------------------------------------------------------- find

extension StageController {
    /// One query for the pane; it follows the tab in front. A page is searched by its page script, a pdf by its viewer, a
    /// file drawn here by its text. A new query starts over; Enter, ↓ and ⌘G step (1), ⇧Enter, ↑ and ⇧⌘G back (−1).
    func runFind(_ text: String, _ step: Int) {
        if pdf != nil { matches = pdfView?.viewer.find(text, step: step, fromStart: false); renderFind(); return }
        if let viewer = fileView?.viewer { let r = viewer.find(text, step: step); matches = JSStr.trim(text).isEmpty ? nil : r; renderFind(); return }
        guard isPageTab, tab.web != nil else { matches = nil; renderFind(); return }
        if text.isEmpty { browser.find(tab.id, ""); matches = nil; renderFind(); return }
        browser.find(tab.id, text, backward: step < 0)
    }

    func renderFind() {
        guard isViewLoaded else { return }
        if finding {
            if findCard.superview !== content { content.addSubview(findCard, positioned: .above, relativeTo: nil) }
            findCard.isHidden = false
            findCard.show(text: findText, found: matches)
        } else { findCard.isHidden = true }
        layoutContent()
    }

    public func openFind() {
        let wasFinding = finding
        finding = true
        renderFind()
        if !wasFinding { runFind(findText, 0) }
        view.window?.makeFirstResponder(findCard.field)
        findCard.field.currentEditor()?.selectAll(nil)
        if showing { browser.show(tab.id, slotRect()) }
    }

    public func closeFind() {
        finding = false
        matches = nil
        if pdf != nil {
            pdfView?.viewer.stopFind()
            if StageModel.landingFinds(tab) { pdfView?.viewer.clearSection() }
        } else if let viewer = fileView?.viewer { viewer.clearFind() }
        else { browser.stopFind(tab.id) }
        renderFind()
        if showing { browser.show(tab.id, slotRect()) }
    }

    /// A link's passage found in a pdf (the viewer's `target`): the find card opens with the words, but for a guide's
    /// sections (the Sections menu says which is shown).
    func landed(_ id: String, _ text: String, _ result: (matches: Int, active: Int)?) {
        let t = tabs.first { $0.id == id }
        update(id) { $0 = StageModel.landTab($0, text) }
        if let t, !StageModel.landingFinds(t) { render(); return }
        let got = pdfView?.viewer.find(text, step: 0, fromStart: true) ?? result
        jumped = (id, text)
        findText = text
        finding = true
        matches = got
        render()
    }

    func clearPending(_ id: String, _ text: String) { update(id) { t in if t.pendingFind == text { t.pendingFind = nil; t.pendingTo = nil; t.pendingPage = nil } } }

    /// A page or a drawn file: the passage found and scrolled to without the card; with the card open, it takes the words.
    func land(_ id: String, _ text: String) {
        clearPending(id, text)
        if !finding || findText == text { runFind(text, 0) } else { findText = text; renderFind() }
    }

    /// A link's passage, once its tab is ready: a page shows its section (page script), and is searched only when it
    /// could not; a drawn file is searched as ⌘F would.
    func pendingFind() {
        guard let text = tab.pendingFind, pdf == nil, visible else { return }
        let id = tab.id
        if let file = drawnFile {
            if file.kind == .error { clearPending(id, text) } else if file.kind != .loading { land(id, text) }
            return
        }
        if isPageTab, let web = tab.web, !web.loading, failed == nil, !web.url.isEmpty, web.url != "about:blank" {
            clearPending(id, text)
            Task { @MainActor in
                let shown = await browser.section(id, text)
                if !shown { land(id, text) }
            }
        }
    }

    func pickSection(_ i: Int) {
        guard let sections = tab.sections, i < sections.count else { return }
        update(tab.id) { $0.activeSection = i }
        pdfView?.viewer.showSection(find: sections[i].find, to: sections[i].to)
        renderContent(force: false)
    }

    func closeSections() {
        update(tab.id) { $0.sections = nil; $0.activeSection = -1 }
        pdfView?.viewer.clearSection()
        renderContent(force: false)
    }

    func marksChanged(_ tabId: String, seq: Int, _ marks: JSONValue) {
        guard let p = tabs.first(where: { $0.id == tabId })?.pdf, p.seq == seq else { return }
        // every other tab holding this pdf takes the ink as it is now: brought forward, it must not save what it read before
        for i in tabs.indices {
            guard let other = tabs[i].pdf else { continue }
            let mine = tabs[i].id == tabId ? other.seq == seq : other.marks != nil && (p.rowId != nil ? other.rowId == p.rowId : other.rowId == nil && other.url == p.url)
            if mine { tabs[i].pdf?.marks = marks }
        }
        Task { @MainActor in
            do {
                if let rowId = p.rowId { try await host?.writeAnnotations(rowId: rowId, marks) } else { try await host?.writePageAnnotations(url: p.url, marks) }
            } catch {}
        }
    }

    func askFromPaper(_ ask: StageAsk) {
        guard let p = pdf else { return }
        var full = ask
        full.rowId = p.rowId; full.url = p.rowId == nil ? p.url : nil; full.paper = p.name
        Task { @MainActor in
            if let entry = await host?.ask(full), let page = full.page { landAnswer(rowId: full.rowId, url: full.url, page: page, markId: full.markId, entry: entry) }
        }
    }

    // -------------------------------------------------------------------------------------------------- the keys

    /// The page's or the Edit menu's shortcuts (`browser:shortcut`): new-tab, close-tab, tab-1…9, find, find-next/previous.
    public func shortcut(_ name: String, from: String?) {
        if name == "new-tab" { host?.showStage(); newTab(); return }
        if name == "close-tab" { host?.showStage(); closeTab(from ?? tab.id); return }
        if name.hasPrefix("tab-"), let n = Int(name.dropFirst(4)), (1...9).contains(n) { tabAt(n - 1); return }
        guard visible else { return }
        if from == nil && name.hasPrefix("find") && (host?.keysToDoc() ?? false) { return }
        if name == "find" { if from != nil || !editableHasKeyboard() || insideHasKeyboard() { openFind() } }
        else if (name == "find-next" || name == "find-previous") && finding { runFind(findText, name == "find-next" ? 1 : -1) }
    }

    /// The Edit ▸ Find menu's items (Find…, Find Next, Find Previous): with the tab whose page has the keyboard.
    public func menuFind(_ name: String) { browser.shortcut(name) }

    func editableHasKeyboard() -> Bool {
        guard let responder = view.window?.firstResponder else { return false }
        return responder is NSTextView || responder is NSTextField
    }
    func insideHasKeyboard() -> Bool {
        guard let responder = view.window?.firstResponder as? NSView else { return false }
        return responder.isDescendant(of: root)
    }

    /// The app's key monitor asks first (Stage.jsx's window keydown): ⌘T while the Stage shows and ⌘W from anywhere but
    /// the terminal (bringing the Stage forward); ⌘F while the Stage shows and has the keyboard or nothing editable does;
    /// ⌘G / ⇧⌘G while finding. `inTerminal`: the terminal has the keyboard (its own tabs). → whether the key was taken.
    public func handleKey(_ event: NSEvent, inTerminal: Bool = false) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard event.type == .keyDown, flags.contains(.command), !flags.contains(.option), !flags.contains(.control), let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
        let docHas = host?.keysToDoc() ?? false
        if (key == "t" || key == "w") && !flags.contains(.shift) {
            if inTerminal || docHas { return false }
            if key == "t" && !visible { return false } // the Terminal shows: ⌘T opens a terminal there
            shortcut(key == "t" ? "new-tab" : "close-tab", from: nil)
            return true
        }
        guard visible else { return false }
        if (key == "f" || key == "g") && docHas { return false }
        if key == "f" && !flags.contains(.shift) && (insideHasKeyboard() || !editableHasKeyboard()) { shortcut("find", from: nil); return true }
        if key == "g" && finding { shortcut(flags.contains(.shift) ? "find-previous" : "find-next", from: nil); return true }
        return false
    }
}

