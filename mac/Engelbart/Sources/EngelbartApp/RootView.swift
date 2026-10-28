import EngelbartCore
import EngelbartUI
import SwiftUI

/// A window's root (App.jsx's render): the screen for its phase, the DirectoryGate over a project with no directory, the
/// error toast, the update banner, the tool setup, the top-right controls, the popups and Settings, all inside the
/// sandbox progress wrapper.
struct RootView: View {
    @ObservedObject var model: RootModel
    @ObservedObject var chrome: WindowChrome
    let context: WindowContext
    let slots: ScreenSlots
    let pickFolder: () async -> String?
    let reveal: (String) -> Void

    var body: some View {
        let window = AnyView(content)
        Group {
            if let wrap = slots.sandboxProgress, model.config != nil { wrap(model, context, window) } else { window }
        }
        .ignoresSafeArea()
        .environmentObject(chrome)
    }

    private var noDirectory: Bool { model.phase == .workspace && model.tree != nil && model.tree?.project.directory == nil }

    private var gate: PopupGate {
        PopupGate.compute(pendingNeed: false, statusSession: false, inWorkspace: model.phase == .workspace, importModal: model.importModal != nil,
                          connectPopup: false, guidedOffer: model.guidedOfferShown, blockedSession: false, setupRequested: model.setup != nil,
                          toolsKnown: model.tools != nil)
    }

    @ViewBuilder private var content: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            if model.config == nil || model.phase == .boot {
                Color.white // boot: a blank white window until it knows where to go
            } else {
                screen.frame(maxWidth: .infinity, maxHeight: .infinity)
                if noDirectory, let project = model.tree?.project {
                    DirectoryGate(project: project, error: model.error, pickFolder: pickFolder,
                                  onChosen: { await model.chooseDirectory($0) }, onHome: { Task { await model.goHome() } })
                        .zIndex(120)
                }
                if !model.error.isEmpty && model.phase != .home && model.phase != .create && !noDirectory {
                    ErrorToast(text: model.error) { model.error = "" }.driveID("error-toast")
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .padding(.leading, 24).padding(.bottom, 18)
                        .zIndex(150)
                }
                if let banner = slots.updateBanner { banner(model, context).zIndex(160) }
                if gate.setup, let setup = model.setup, let dialog = slots.toolSetup { dialog(model, context, setup).zIndex(170) }
                WindowControls(model: model, context: context, slots: slots)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .zIndex(gate.any ? 130 : 200)
                if gate.offer, let offer = slots.guidedOffer { offer(model, context).zIndex(140) }
                if let place = model.importModal, model.phase == .workspace { importModal(place).zIndex(140) }
                ForEach(Array(slots.popups.enumerated()), id: \.offset) { _, popup in popup(model, context).zIndex(145) }
                if let page = model.settingsPage { settings(page).zIndex(300) }
            }
        }
    }

    @ViewBuilder private var screen: some View {
        switch model.phase {
        case .boot:
            Color.white
        case .home:
            if let home = slots.home { home(model, context) }
            else if ShellDemo.mode == "kit" { KitGallery() }
            else { ScreenPlaceholder(name: "All projects", detail: "Home screen slot", slot: "home") }
        case .create:
            if let onboarding = slots.onboarding { onboarding(model, context).id(model.run) }
            else { ScreenPlaceholder(name: "Onboarding", detail: "Onboarding slot · \(model.onboardMode.rawValue)", slot: "create").id(model.run) }
        case .workspace:
            Group {
                if let workspace = slots.workspace { workspace(model, context) }
                else {
                    ScreenPlaceholder(name: model.tree?.project.name ?? "Workspace", detail: "Workspace slot", slot: "workspace")
                        .onAppear { if let id = model.entry?.workspaceId { model.onVisit(id) } }
                }
            }
            .id(model.tree?.project.id)
            .blur(radius: noDirectory ? 6 : 0)
            .allowsHitTesting(!noDirectory)
        }
    }

    /// Import your context over the workspace (2026-10-13: "a popup modal in front of the workspace"): 1000 × 800, radius
    /// 14, over a rgba(23,23,23,.18) veil; the panel never scrolls, the flow inside it does.
    private func importModal(_ place: WindowPlace) -> some View {
        GeometryReader { geo in
            ZStack {
                Color(Palette.veil)
                Group {
                    if let flow = slots.importFlow { flow(model, context, place) } else { SlotPlaceholder("Import your context") }
                }
                .frame(width: min(1000, geo.size.width - 48), height: min(800, geo.size.height - 48))
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .compositingGroup().shadow(color: .black.opacity(0x26 / 255.0), radius: 30, x: 0, y: 20)
            }
        }
    }

    private func settings(_ page: String) -> some View {
        let close = { model.settingsPage = nil }
        let test: TestDataActions? = model.config.flatMap { config in
            guard config.testModeAvailable else { return nil }
            return TestDataActions(testMode: config.testMode, testRootShown: AppPaths.shown(URL(fileURLWithPath: config.testRoot)),
                                   onReveal: { reveal(config.testRoot) },
                                   onStartNew: { Task { await model.resetTest(fresh: true) } },
                                   onReset: { Task { await model.resetTest(fresh: false) } })
        }
        let pages = SettingsPages.standard(
            models: { _ in AnyView(ModelsPage(source: slots.modelSettings)) },
            connections: slots.settingsConnections,
            startImport: { Task { await model.startGuided() } })
        return SettingsDialog(pages: pages, context: SettingsContext(test: test, close: close), initialPage: page.isEmpty ? nil : page)
            .id(page)
    }
}

/// App.jsx's error line: bottom-left, red 12.5px in a white bordered card, a × that clears it.
struct ErrorToast: View {
    let text: String
    let onClear: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Text(text).textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.del))
            Button(action: onClear) { Text("×").font(Fonts.swiftUISans(14)).padding(.horizontal, 2) }
                .buttonStyle(.plain).foregroundStyle(Color(Palette.bd2))
        }
        .padding(.vertical, 7).padding(.horizontal, 12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(Palette.bd), lineWidth: 1))
    }
}
