import AppKit
import Combine
import SwiftUI
import EngelbartDoc
import EngelbartIntegrations
import EngelbartStore
import EngelbartUI

// The all-projects screen's "Add context" (Rail.jsx AddToLibrary + AddMenuBody, 2026-09-23 Sidebar.dc.html's "+ Add
// context"; Home.jsx uses it, 2026-09-28): its row, and the menu hanging under it. With `search`, a search over the
// library first, whose rows bring what they find in; a new Note, Sticky or Sub-Workspace when their handlers are given;
// then a link or a path, files from disk, or a repository from GitHub (GithubPane), each a new row of the library. It
// cannot close while it is adding. Also the marks Home draws (TRASH_MARK).

public enum SidebarMarks {
    /// A project card's Delete (Home.jsx): a small can, drawn in the minus's line (16 grid, 1.3 stroke, 15 px).
    public static let trash = Icon("Delete", grid: 16, stroke: 1.3, size: 15, [IconShape(.path("M2.5 4h11 M6.25 4V2.75a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75V4 M3.75 4l.7 9.1a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.7-9.1 M6.75 6.75v4.5 M9.25 6.75v4.5"))])
    /// Add context's circled plus (18 grid, 1.3 stroke).
    public static let circlePlus = Icon("Add context", grid: 18, stroke: 1.3, size: 18, [IconShape(.circle(cx: 9, cy: 9, r: 7.5)), IconShape(.path("M9 5.5v7 M5.5 9h7"))])
}

@MainActor
public final class AddMenuModel: ObservableObject {
    public enum View { case menu, github }
    @Published public var view: View = .menu
    @Published public var value = "" { didSet { if value != oldValue { run.error = "" } } }
    @Published public var q = "" { didSet { if q != oldValue { idx = 0; run.error = ""; lookup.typed(typed) } } }
    @Published public var idx = 0
    public let run: AddRun
    public let search: Bool
    @Published public var library: [LibraryRow]
    public var inRail: (String) -> Bool
    let lookup: LookupModel
    let bodies = BodiesModel()
    public var onAdd: (String) async throws -> Void = { _ in }
    public var onPickDisk: () async throws -> [String] = { [] }
    public var onNewNote: (() async throws -> Void)? = nil
    public var onNewSticky: (() async throws -> Void)? = nil
    public var onNewChild: (() async throws -> Void)? = nil
    public var onPickRepo: (GithubRow) async throws -> Void = { _ in }
    public var onSearchPick: (SearchResult, String) async throws -> Void = { _, _ in }
    private var bag: [AnyCancellable] = []

    public init(search: Bool = true, library: [LibraryRow], inRail: @escaping (String) -> Bool, lookup: @escaping (String) async throws -> Library.Lookup, onDone: (() -> Void)? = nil) {
        self.search = search; self.library = library; self.inRail = inRail
        self.lookup = LookupModel(ask: lookup, delay: 0.12)
        self.run = AddRun(done: onDone)
        bag.append(run.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
        bag.append(self.lookup.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
        bag.append(bodies.objectWillChange.sink { [weak self] in self?.objectWillChange.send() })
    }

    public var busy: Bool { run.busy }
    public var typed: String { q.trimmed }
    public var addable: Bool { RailModel.looksAddable(value) }
    var answer: Library.Lookup? { search && RailModel.looksAddable(typed) ? lookup.answer(typed) : nil }
    public var results: [SearchResult] { search && !typed.isEmpty ? RailModel.searchRows(query: typed, library: library, inRail: inRail, found: answer, bodies: bodies.bodies) : [] }
    public var at: Int { results.isEmpty ? -1 : min(idx, results.count - 1) }
    var searchProblem: String { answer?.error ?? "" }

    public func commit() { let input = value.trimmed; if !input.isEmpty && !busy { run.run { try await self.onAdd(input); return [] } } }
    public func make(_ work: (() async throws -> Void)?) { guard let work, !busy else { return }; run.run { try await work(); return [] } }
    public func pickDisk() { guard !busy else { return }; run.run { try await self.onPickDisk() } }
    public func pick(_ result: SearchResult?) { guard let result, !busy else { return }; let t = typed; run.run { try await self.onSearchPick(result, t); return [] } }
    public func searchKey(_ key: FieldKey) -> Bool {
        let n = results.count
        switch key {
        case .down: if n > 0 { idx = (at + 1) % n }; return true
        case .up: if n > 0 { idx = (at - 1 + n) % n }; return true
        case .enter: if at >= 0 { pick(results[at]) }; return true
        case .escape: if !q.isEmpty { q = ""; idx = 0; return true }; return false
        default: return false
        }
    }
}

/// The menu's body (AddMenuBody).
public struct AddMenuBodyView: View {
    @ObservedObject var model: AddMenuModel
    let github: GithubPaneModel?
    public init(model: AddMenuModel, github: GithubPaneModel?) { self.model = model; self.github = github }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.view == .github, let github {
                GithubPaneView(model: github, library: model.library.map { GithubLibraryRow(id: $0.id, githubId: $0.githubId, url: $0.url) }, inRail: model.inRail, busy: model.busy,
                               onBack: { model.view = .menu; model.run.error = "" }, onPick: { entry in model.make { try await model.onPickRepo(entry) } })
                if !model.run.error.isEmpty { AddErrorText(text: model.run.error) }
            } else {
                if model.search {
                    HStack(spacing: 8) {
                        SBIcon(SidebarIcons.search, size: 14, stroke: 2.6).foregroundStyle(Color(Palette.ink))
                        PanelTextField(text: $model.q, placeholder: "Search", font: Fonts.sans(14), readOnly: model.busy, id: "add-search", onKey: model.searchKey)
                        if !model.q.isEmpty { Button { model.q = "" } label: { Text("×").font(sans(13)).foregroundStyle(Color(Palette.bd2)) }.buttonStyle(.plain).accessibilityLabel("Clear") }
                    }
                    .padding(.horizontal, 10).frame(height: 33)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(model.q.isEmpty ? Palette.bd : Palette.bd2), lineWidth: 1))
                    .padding(.bottom, 6)
                }
                if !model.typed.isEmpty {
                    ForEach(Array(model.results.enumerated()), id: \.element.key) { i, result in
                        PickerItem(selected: i == model.at, disabled: model.busy, action: { model.pick(result) }, onHover: { if $0 && model.idx != i { model.idx = i } }) {
                            RowGlyph(key: result.row != nil ? glyphKey(result.row) : glyphKey(result.found))
                            Text(result.name).font(sans(14)).lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 0)
                            if result.tag.hasPrefix("new") { Text("+").font(sans(15)).foregroundStyle(Color(Palette.fnt)).frame(width: 16) }
                            else { Text(result.tag.uppercased()).font(sans(10, 500)).tracking(1.2).foregroundStyle(Color(Palette.fnt)) }
                        }.driveID("add-result=\(result.key)")
                    }
                    let problem = model.searchProblem.isEmpty ? model.run.error : model.searchProblem
                    if !problem.isEmpty { AddErrorText(text: problem) }
                } else {
                    if !model.search { linkField; if !model.run.error.isEmpty { AddErrorText(text: model.run.error) }; if model.addable { addButton } }
                    if model.onNewNote != nil { PickerItem(selected: false, disabled: model.busy, action: { model.make(model.onNewNote) }) { SBIcon(SidebarIcons.note, size: 16); Text("Note").font(sans(14)) }.driveID("new=note") }
                    if model.onNewSticky != nil { PickerItem(selected: false, disabled: model.busy, action: { model.make(model.onNewSticky) }) { SBIcon(SidebarIcons.sticky(), size: 16); Text("Sticky").font(sans(14)) }.padding(.top, 2).driveID("new=sticky") }
                    if model.onNewChild != nil { PickerItem(selected: false, disabled: model.busy, action: { model.make(model.onNewChild) }) { SBIcon(SidebarIcons.workspace, size: 16); Text("Sub-Workspace").font(sans(14)) }.padding(.top, 2).driveID("new=workspace") }
                    if model.search && (model.onNewNote != nil || model.onNewChild != nil) { Rectangle().fill(Color(Palette.bd)).frame(height: 1).padding(EdgeInsets(top: 6, leading: 0, bottom: 8, trailing: 0)) }
                    if model.search { linkField; if !model.run.error.isEmpty { AddErrorText(text: model.run.error) } }
                    PickerItem(selected: false, disabled: model.busy, action: model.pickDisk) { SBIcon(SidebarIcons.folder, size: 16); Text("Choose from disk…").font(sans(14)) }.driveID("add-disk")
                    if github != nil {
                        PickerItem(selected: false, disabled: model.busy, action: { model.run.error = ""; model.view = .github }) { KindGlyph("git", box: 16, color: Palette.ink); Text("Add from GitHub…").font(sans(14)) }
                            .padding(.top, 2).driveID("add-github")
                    }
                    if model.search && model.addable { addButton }
                }
            }
        }
    }

    var linkField: some View {
        HStack {
            LinkField(text: $model.value, focusTick: 0, readOnly: model.busy, onEnter: model.commit)
        }
        .padding(.horizontal, 10).frame(height: 33)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.gray50)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(!model.run.error.isEmpty ? Palette.del : model.value.isEmpty ? Palette.bd : Palette.bd2), lineWidth: 1))
        .padding(.vertical, 4)
    }
    var addButton: some View {
        HStack {
            Spacer()
            Button(action: model.commit) {
                Text("Add to library").font(sans(12.5, 500)).foregroundStyle(Color.white).padding(EdgeInsets(top: 7, leading: 12, bottom: 7, trailing: 12))
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.ink)))
            }.buttonStyle(.plain).disabled(model.busy).hover(.dim, radius: 6).driveID("add-to-library")
        }.padding(.top, 8)
    }
}

struct AddErrorText: View {
    let text: String
    var body: some View { Text(text).font(sans(12)).foregroundStyle(Color(Palette.del)).fixedSize(horizontal: false, vertical: true).padding(EdgeInsets(top: 6, leading: 2, bottom: 0, trailing: 2)).driveID("add-error") }
}

/// "Add context" (Home.jsx's library rail): the row (circled plus, 14px, #8f8f8f → #171717 on #f2f2f2 while open) and the
/// menu under it (as wide as the row, 4 below, padding 10, white, 1px #eaeaea, radius 8). A press on the row toggles it; a
/// press elsewhere or Escape closes it unless it is adding.
public struct AddToLibraryView: View {
    @ObservedObject var model: AddMenuModel
    let github: GithubPaneModel?
    @State private var open = false
    var onOpenChange: (Bool) -> Void
    public init(model: AddMenuModel, github: GithubPaneModel?, onOpenChange: @escaping (Bool) -> Void = { _ in }) {
        self.model = model; self.github = github; self.onOpenChange = onOpenChange
    }
    public var body: some View {
        Button { if open { if !model.busy { open = false } } else { open = true } } label: {
            HStack(spacing: 9) {
                SBIcon(SidebarMarks.circlePlus, size: 18)
                Text("Add context").font(sans(14))
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color(open ? Palette.ink : Palette.fnt))
            .padding(EdgeInsets(top: 6, leading: 10, bottom: 8, trailing: 10))
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.gray150).opacity(open ? 1 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hover(.wash, radius: 6)
        .accessibilityLabel("Add context")
        .floatingPanel(isPresented: Binding(get: { open }, set: { if !$0 && model.busy { return }; open = $0 }),
                       options: FloatingOptions(side: .below, gap: 4, cap: 620, card: false)) {
            AddMenuBodyView(model: model, github: github)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(Palette.bd), lineWidth: 1))
        }
        .onChange(of: open) { _, on in onOpenChange(on) }
        .onAppear { model.run.done = { open = false } }
        .driveID("rail-add")
    }
}
