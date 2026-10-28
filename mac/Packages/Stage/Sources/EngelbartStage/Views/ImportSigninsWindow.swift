import AppKit
import EngelbartUI

// "Import sign-ins…" (MATH-18, src/renderer/workspace/ImportSignins.jsx): a picker that reads the person's own browsers and
// writes the sign-ins they tick into the Stage's session. Domains and counts only; cookie values never leave the importer.
// browser → profile (skipped with one) → domains (search, GitHub, Google, Overleaf and Zotero ticked) → Importing… →
// done (each check: ✓ signed in, or Sign in again, which opens the site on the Stage). Escape closes it, wherever the
// keyboard is. A sheet on the window: 460 wide, at most 600 tall, the panel's white, a 12pt radius.

@MainActor
final class ImportSigninsWindow: NSObject {
    static var open: ImportSigninsWindow?
    static let checkSites = ["github.com": "GitHub", "google.com": "Google", "overleaf.com": "Overleaf", "zotero.org": "Zotero"]
    static let siteURL = ["github.com": "https://github.com", "google.com": "https://myaccount.google.com", "overleaf.com": "https://www.overleaf.com/project", "zotero.org": "https://www.zotero.org"]

    let panel: NSPanel
    let importer: CookieImport
    let onOpenSite: (String) -> Void
    weak var parent: NSWindow?
    let body = FlippedView()
    let error = makeLabel("", size: 12.5, color: Palette.del, lines: 0)
    let primary = TextButton("", size: 13, weight: 500, color: .white, radius: 8)
    let ghost = TextButton("Cancel", size: 13, color: Palette.fnt)
    var step = "browser"
    var sources: [CookieImport.Source]?
    var browser: CookieImport.Source?
    var profile: CookieImport.Profile?
    var domains: [(domain: String, count: Int)]?
    var ticked: Set<String> = []
    var query = ""
    var result: CookieImport.Result?

    static func show(over window: NSWindow?, importer: CookieImport, onOpenSite: @escaping (String) -> Void) {
        let picker = ImportSigninsWindow(importer: importer, onOpenSite: onOpenSite)
        open = picker
        picker.parent = window
        if let window { window.beginSheet(picker.panel) } else { picker.panel.center(); picker.panel.makeKeyAndOrderFront(nil) }
        picker.load()
    }

    init(importer: CookieImport, onOpenSite: @escaping (String) -> Void) {
        self.importer = importer
        self.onOpenSite = onOpenSite
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 460, height: 420), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        panel.backgroundColor = Palette.panel
        let root = FlippedView(); root.fill = Palette.panel
        panel.contentView = root
        root.addSubview(body)
        let foot = FlippedView()
        let line = FlippedView(); line.fill = Palette.bd
        foot.addSubview(line); foot.addSubview(error); foot.addSubview(primary); foot.addSubview(ghost)
        root.addSubview(foot)
        body.frame = NSRect(x: 0, y: 0, width: 460, height: 360)
        foot.frame = NSRect(x: 0, y: 360, width: 460, height: 60)
        line.frame = NSRect(x: 0, y: 0, width: 460, height: 1)
        error.frame = NSRect(x: 18, y: 12, width: 300, height: 36)
        primary.baseFill = Palette.ink
        primary.frame = NSRect(x: 460 - 18 - 110, y: 13, width: 110, height: 34)
        ghost.frame = NSRect(x: 460 - 18 - 80, y: 13, width: 80, height: 34)
        ghost.onClick = { [weak self] in self?.close() }
        primary.onClick = { [weak self] in guard let self else { return }; if self.step == "domains" { self.run() } else { self.close() } }
        escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, let self { self.close(); return nil }
            return event
        }
    }
    private var escape: Any?

    func close() {
        if let escape { NSEvent.removeMonitor(escape) }
        escape = nil
        if let parent { parent.endSheet(panel) } else { panel.close() }
        ImportSigninsWindow.open = nil
    }

    func load() {
        sources = importer.sources()
        if sources?.isEmpty ?? true { error.stringValue = "No supported browsers were found on this Mac." }
        draw()
    }

    func pickBrowser(_ b: CookieImport.Source) {
        browser = b; error.stringValue = ""
        if b.profiles.count == 1 { pickProfile(b.profiles[0]) } else { step = "profile"; draw() }
    }

    func pickProfile(_ p: CookieImport.Profile) {
        profile = p; step = "domains"; domains = nil; error.stringValue = ""
        draw()
        do {
            let got = try importer.domains(browser!.id, p.id)
            domains = got.domains
            ticked = Set(got.defaults.filter { d in got.domains.contains { $0.domain == d } })
            if got.needs == "disk-access" { error.stringValue = "Engelbart needs Full Disk Access to read Safari's sign-ins." }
        } catch { self.error.stringValue = error.localizedDescription }
        draw()
    }

    func run() {
        guard !ticked.isEmpty else { error.stringValue = "Tick at least one site to import."; return }
        step = "importing"; error.stringValue = ""; draw()
        let chosen = domains?.map(\.domain).filter { ticked.contains($0) } ?? Array(ticked)
        Task { @MainActor in
            do { result = try await importer.run(browser: browser!.id, profile: profile!.id, domains: chosen); step = "done" }
            catch { self.error.stringValue = error.localizedDescription; step = "domains" }
            draw()
        }
    }

    private func heading(_ title: String, _ sub: String?) -> [NSView] {
        let t = makeLabel(title, size: 15, weight: 500)
        var out: [NSView] = [t]
        if let sub { let s = makeLabel(sub, size: 12.5, color: Palette.fnt, lines: 0); s.preferredMaxLayoutWidth = 424; out.append(s) }
        return out
    }

    private func rowButton(_ title: String, detail: String = "", _ run: @escaping () -> Void) -> NSView {
        let b = TextButton("", size: 13.5, color: Palette.ink, radius: 8)
        let text = NSMutableAttributedString(string: title, attributes: [.font: Fonts.sans(13.5), .foregroundColor: Palette.ink])
        if !detail.isEmpty { text.append(NSAttributedString(string: "   \(detail)", attributes: [.font: Fonts.sans(12), .foregroundColor: Palette.fnt])) }
        text.append(NSAttributedString(string: "   ›", attributes: [.font: Fonts.sans(13.5), .foregroundColor: Palette.bd2]))
        b.attributedTitle = text
        b.alignment = .left
        b.baseFill = Palette.panel; b.layer?.borderWidth = 1; b.layer?.borderColor = Palette.bd.cgColor
        b.onClick = run
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: 424).isActive = true
        b.heightAnchor.constraint(equalToConstant: 38).isActive = true
        return b
    }

    func draw() {
        for v in body.subviews { v.removeFromSuperview() }
        var views: [NSView] = []
        switch step {
        case "browser":
            views += heading("Import sign-ins", "Bring your sign-ins from another browser so sites open already signed in. Your passwords stay in that browser.")
            if sources == nil && error.stringValue.isEmpty { views.append(makeLabel("Looking for your browsers…", size: 12.5, color: Palette.fnt)) }
            for s in sources ?? [] { views.append(rowButton(s.name, detail: s.profiles.count == 1 ? "1 profile" : "\(s.profiles.count) profiles") { [weak self] in self?.pickBrowser(s) }) }
        case "profile":
            views += heading("\(browser?.name ?? "") · choose a profile", nil)
            for p in browser?.profiles ?? [] { views.append(rowButton(p.name) { [weak self] in self?.pickProfile(p) }) }
        case "domains":
            views += heading("Choose sites to import", "\(browser?.name ?? "") · \(profile?.name ?? ""). GitHub, Google, Overleaf and Zotero are ticked for you.")
            let search = NSSearchField(); search.placeholderString = "search sites…"; search.stringValue = query
            search.target = self; search.action = #selector(searched(_:))
            search.translatesAutoresizingMaskIntoConstraints = false; search.widthAnchor.constraint(equalToConstant: 424).isActive = true
            views.append(search)
            if domains == nil && error.stringValue.isEmpty { views.append(makeLabel("Reading cookies…", size: 12.5, color: Palette.fnt)) }
            let words = query.lowercased().split(separator: " ").map(String.init)
            let shown = (domains ?? []).filter { row in words.allSatisfy { row.domain.contains($0) } }
            for row in shown.prefix(200) {
                let on = ticked.contains(row.domain)
                let name = ImportSigninsWindow.checkSites[row.domain].map { "\($0) · \(row.domain)" } ?? row.domain
                let b = TextButton("", size: 13.5, color: Palette.ink)
                let text = NSMutableAttributedString(string: on ? "✓  " : "○  ", attributes: [.font: Fonts.sans(13, weight: 600), .foregroundColor: on ? NSColor(hex: "#1f9d55") : Palette.bd2])
                text.append(NSAttributedString(string: "\(name)   ", attributes: [.font: Fonts.sans(13.5), .foregroundColor: Palette.ink]))
                text.append(NSAttributedString(string: "\(row.count)", attributes: [.font: Fonts.sans(12), .foregroundColor: Palette.fnt]))
                b.attributedTitle = text; b.alignment = .left
                b.onClick = { [weak self] in guard let self else { return }; if on { self.ticked.remove(row.domain) } else { self.ticked.insert(row.domain) }; self.draw() }
                views.append(b)
            }
            if domains != nil && shown.isEmpty { views.append(makeLabel("No sites match.", size: 12.5, color: Palette.fnt)) }
        case "importing":
            views.append(makeLabel("Importing…", size: 12.5, color: Palette.fnt))
        default:
            let r = result!
            views += heading("Imported \(r.imported) sign-in\(r.imported == 1 ? "" : "s")", "\(browser?.name ?? "") · \(profile?.name ?? "")\(r.skipped > 0 ? " · \(r.skipped) could not be read" : "")\(r.sessionOnly > 0 ? " · \(r.sessionOnly) last only this session" : "").")
            if r.checks.isEmpty { views.append(makeLabel("These sites will open on the Stage with their sign-ins.", size: 12.5, color: Palette.fnt)) }
            for c in r.checks {
                let line = NSStackView(); line.orientation = .horizontal
                line.addArrangedSubview(makeLabel(c.site, size: 13.5))
                if c.signedIn == true { line.addArrangedSubview(makeLabel("✓ signed in", size: 12.5, color: NSColor(hex: "#1f9d55"))) }
                else {
                    let again = TextButton("Sign in again", size: 12.5, weight: 500, color: Palette.acc)
                    again.onClick = { [weak self] in self?.onOpenSite(ImportSigninsWindow.siteURL[c.domain] ?? "https://\(c.domain)"); self?.close() }
                    line.addArrangedSubview(again)
                }
                views.append(line)
            }
        }
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 460, height: 360))
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true
        let doc = FlippedView(frame: NSRect(x: 0, y: 0, width: 460, height: max(360, stack.fittingSize.height + 32)))
        stack.frame = NSRect(x: 18, y: 16, width: 424, height: stack.fittingSize.height)
        doc.addSubview(stack)
        scroll.documentView = doc
        body.addSubview(scroll)
        primary.isHidden = !(step == "domains" || step == "done")
        ghost.isHidden = primary.isHidden == false
        primary.setTitle(step == "done" ? "Done" : "Import \(ticked.isEmpty ? "" : String(ticked.count))", size: 13, weight: 500, color: .white)
        primary.alphaValue = step == "domains" && ticked.isEmpty ? 0.5 : 1
    }

    @objc func searched(_ field: NSSearchField) { query = field.stringValue; draw() }
}
