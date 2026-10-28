import AppKit
import EngelbartCore
import EngelbartUI
import SwiftUI

// The setup dialog for Git, Claude Code and Codex (src/renderer/ui/ToolSetup.jsx, 2026-09-23; design D15). After the
// launch check it opens with only what needs the person (mode launch); Engelbart ▸ Set Up Tools… opens it with all three
// (mode all), where a skipped tool can be asked about again and automatic updates turned off. Rows follow the manager's
// snapshot as installs, updates and sign-ins run. No divider lines anywhere (Hudson, 2026-10-14).

/// What the dialog's buttons call: the tools channels, and the browser for Open page.
public struct ToolSetupBackend {
    public var install: ([String]) throws -> Void
    public var update: (String) throws -> Void
    public var signIn: (String) throws -> Void
    public var cancelSignIn: (String) throws -> Void
    public var check: () -> Void
    public var skip: ([String]) throws -> Void
    public var askAgain: (String) throws -> Void
    public var setUpdates: (String) -> Void
    /// Open page: the default browser (never the Stage).
    public var openPage: (String) -> Void

    public init(install: @escaping ([String]) throws -> Void, update: @escaping (String) throws -> Void, signIn: @escaping (String) throws -> Void,
                cancelSignIn: @escaping (String) throws -> Void, check: @escaping () -> Void, skip: @escaping ([String]) throws -> Void,
                askAgain: @escaping (String) throws -> Void, setUpdates: @escaping (String) -> Void, openPage: @escaping (String) -> Void) {
        self.install = install; self.update = update; self.signIn = signIn; self.cancelSignIn = cancelSignIn; self.check = check
        self.skip = skip; self.askAgain = askAgain; self.setUpdates = setUpdates; self.openPage = openPage
    }

    @MainActor
    public static func channels(_ c: ToolsChannels, openPage: @escaping (String) -> Void = { url in if let u = URL(string: url) { NSWorkspace.shared.open(u) } }) -> ToolSetupBackend {
        ToolSetupBackend(install: { try c.install($0) }, update: { try c.update($0) }, signIn: { try c.signIn($0) }, cancelSignIn: { try c.cancelSignIn($0) },
                         check: { Task { await c.check() } }, skip: { try c.skip($0) }, askAgain: { try c.askAgain($0) }, setUpdates: { c.setUpdates($0) },
                         openPage: openPage)
    }
}

@MainActor
public final class ToolSetupModel: ObservableObject {
    @Published public var snapshot: ToolsSnapshot
    public let ids: [String]
    public let mode: SetupGate.Mode
    /// The lines Skip warns with, while it waits to be confirmed.
    @Published public private(set) var warning: [String]?
    @Published public private(set) var error = ""
    let backend: ToolSetupBackend
    public var onClose: () -> Void

    public init(snapshot: ToolsSnapshot, ids: [String], mode: SetupGate.Mode = .launch, backend: ToolSetupBackend, onClose: @escaping () -> Void) {
        self.snapshot = snapshot; self.ids = ids; self.mode = mode; self.backend = backend; self.onClose = onClose
    }

    public var title: String { mode == .all ? "Tools" : "Set up Engelbart" }
    public var rows: [ToolRow] { ids.compactMap { snapshot[$0].map(rowOf) } }
    public var pending: [String] { ids.filter { needsAction(snapshot[$0]) } }
    public var toInstall: [String] { installable(snapshot, ids) }
    public var done: Bool { allDone(snapshot, ids) }

    public enum Footer: Equatable {
        /// Set Up Tools…: Update automatically · Check again · Done.
        case all(updatesOn: Bool)
        /// Every row ready: Done.
        case done
        /// Install all (two or more to install) · Skip (anything pending).
        case launch(installAll: Bool, skip: Bool)
    }

    public var footer: Footer {
        if mode == .all { return .all(updatesOn: snapshot.updates != "ask") }
        if done { return .done }
        return .launch(installAll: toInstall.count > 1, skip: !pending.isEmpty)
    }

    func run(_ body: () throws -> Void) {
        do { try body() } catch { self.error = error.localizedDescription }
    }

    public func act(_ row: ToolRow) {
        error = ""
        switch row.action {
        case "install": run { try backend.install([row.id]) }
        case "update": run { try backend.update(row.id) }
        case "sign-in": run { try backend.signIn(row.id) }
        case "cancel": run { try backend.cancelSignIn(row.id) }
        case "retry": run { if snapshot[row.id]?.installed == true { backend.check() } else { try backend.install([row.id]) } }
        default: break
        }
    }

    public func installAll() { error = ""; let names = toInstall; run { try backend.install(names) } }

    /// Skip: the warnings first when there are any, else skipped and closed.
    public func skip() {
        let lines = skipWarnings(snapshot, pending)
        if !lines.isEmpty { warning = lines; return }
        confirmSkip()
    }

    public func confirmSkip() {
        let names = pending
        run { try backend.skip(names) }
        onClose()
    }

    public func back() { warning = nil }
    public func askAgain(_ id: String) { run { try backend.askAgain(id) } }
    public func openPage(_ url: String) { backend.openPage(url) }
    public func setUpdates(_ on: Bool) { backend.setUpdates(on ? "auto" : "ask") }
    public func checkAgain() { backend.check() }
    public func close() { onClose() }
}

/// The dialog, over the whole window (role dialog, aria-modal; z 130 above the workspace).
public struct ToolSetupView: View {
    @ObservedObject var model: ToolSetupModel

    public init(model: ToolSetupModel) { self.model = model }

    static let tone: [String: NSColor] = ["ok": Palette.ink, "muted": Palette.fnt, "busy": Palette.fnt, "warn": ToolColors.warn, "error": Palette.del]

    public var body: some View {
        ZStack {
            Color(ToolColors.backdrop).ignoresSafeArea()
            card
                .frame(maxWidth: 500)
                .padding(24)
        }
        .background(ToolsKeyTrap(keyCode: 53) { model.close() }) // Escape closes the dialog only
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Set up Engelbart")
    }

    var card: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                Text(model.title).font(Font(Fonts.sans(20, weight: 500))).tracking(-0.2).foregroundStyle(Color(Palette.ink))
                Spacer(minLength: 0)
                Button(action: model.close) { Text("×").font(Font(Fonts.sans(18))) }
                    .buttonStyle(.plain).toolsHover(.ink, rest: Palette.bd2).accessibilityLabel("Close")
            }
            if let warning = model.warning {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(warning, id: \.self) { line in
                        Text(line).font(Font(Fonts.sans(13.5))).lineSpacing(13.5 * 0.6 - 2).foregroundStyle(Color(Palette.ink)).fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 14) {
                        primary("Skip anyway", fill: Palette.ink, action: model.confirmSkip).keyboardShortcut(.defaultAction)
                        quiet("Back", action: model.back)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(model.rows, id: \.id) { row in rowView(row) }
                }
                if !model.error.isEmpty {
                    Text(model.error).font(Font(Fonts.sans(12.5))).foregroundStyle(Color(Palette.del)).fixedSize(horizontal: false, vertical: true)
                }
                footer
            }
        }
        .padding(28)
        // The shadow belongs to the card's box only (a SwiftUI shadow on the stack would shade every row's text too).
        .background(RoundedRectangle(cornerRadius: Radius.lg).fill(Color(Palette.panel)).shadow(color: Color(ToolColors.shadow), radius: 20, x: 0, y: 12))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).stroke(Color(Palette.bd2), lineWidth: 1))
        .toolsRise(0.2)
    }

    @ViewBuilder var footer: some View {
        HStack(spacing: 14) {
            switch model.footer {
            case .all(let updatesOn):
                Toggle(isOn: Binding(get: { updatesOn }, set: { model.setUpdates($0) })) {
                    Text("Update automatically").font(Font(Fonts.sans(13))).foregroundStyle(Color(Palette.ink))
                }
                .toggleStyle(.checkbox)
                Spacer(minLength: 0)
                quiet("Check again", action: model.checkAgain)
                primary("Done", action: model.close)
            case .done:
                primary("Done", action: model.close).keyboardShortcut(.defaultAction)
            case .launch(let installAll, let skip):
                if installAll { primary("Install all", action: model.installAll) }
                Spacer(minLength: 0)
                if skip { quiet("Skip", action: model.skip) }
            }
        }
    }

    func rowView(_ row: ToolRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 12) {
                Text(row.name).font(Font(Fonts.sans(13.5, weight: 500))).foregroundStyle(Color(Palette.ink)).frame(width: 112, alignment: .leading)
                HStack(spacing: 6) {
                    if row.tone == "ok" { CheckMark() }
                    if row.tone == "busy" { PulseDot() }
                    Text(row.state).font(Font(Fonts.mono(12))).foregroundStyle(Color(Self.tone[row.tone] ?? Palette.fnt)).lineLimit(1).truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 10) {
                    if let page = row.page { quietSmall("Open page") { model.openPage(page) } }
                    if model.mode == .all && row.skipped { quietSmall("Ask again") { model.askAgain(row.id) } }
                    if let action = row.action {
                        Button { model.act(row) } label: {
                            Text(ACTION_LABEL[action] ?? action).font(Font(Fonts.sans(12.5, weight: 500))).foregroundStyle(Color(Palette.ink))
                                .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 30)
                        }
                        .buttonStyle(.plain)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color(Palette.panel)))
                        .toolsHover(.wash, rest: Palette.ink, radius: 7)
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color(Palette.bd), lineWidth: 1))
                    }
                }
            }
            if let detail = row.detail {
                Text(detail).font(Font(Fonts.sans(12))).lineSpacing(2).foregroundStyle(Color(Self.tone[row.detailTone] ?? Palette.del))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 10)
    }

    func primary(_ title: String, fill: NSColor = Palette.acc, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Font(Fonts.sans(13, weight: 500))).foregroundStyle(Color(Palette.onAcc))
                .padding(.horizontal, 16).padding(.vertical, 9).frame(minHeight: 36)
                .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(fill)))
                .contentShape(RoundedRectangle(cornerRadius: Radius.sm))
        }
        .buttonStyle(.plain)
    }

    func quiet(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(Font(Fonts.sans(13))) }.buttonStyle(.plain).toolsHover(.ink, rest: Palette.fnt)
    }

    func quietSmall(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(Font(Fonts.sans(12.5))) }.buttonStyle(.plain).toolsHover(.ink, rest: Palette.fnt)
    }
}
