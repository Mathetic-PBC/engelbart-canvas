import EngelbartUI
import SwiftUI

/// Every UI-kit primitive on one screen, for the cloud self-test's pictures (`ENGELBART_SHELL_DEMO=kit`): buttons, options,
/// the pager, thinking dots, the wave, fluid tabs, the inline field, icons, the tooltip's face, a tab card, Settings rows.
/// Identifiers start with `kit-` so a drive script can press them.
struct KitGallery: View {
    @State private var option = 0
    @State private var panel = false
    @State private var committed = ""

    var body: some View {
        VStack(spacing: 0) {
            PlaceholderHeader(title: "Engelbart")
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    section("Buttons") {
                        HStack(spacing: 9) {
                            EButton("Outline", .outline, action: {}).driveID("kit-outline")
                            EButton("Filled", .filled, action: {})
                            EButton("Link", .link, action: {})
                            EButton("Choose folder…", .blue, action: {})
                            EButton("All projects", .ghost, action: {})
                            EButton("Next", .filled, size: .sm, go: true, action: {})
                            EButton("Disabled", .outline, action: {}).disabled(true)
                        }
                        HStack(spacing: 9) {
                            EButton("Test · on", .filled, size: .sm, caps: true, action: {})
                            EButton("Test · off", .outline, size: .sm, caps: true, action: {})
                            EButton("Continue", .outline, caps: true, go: true, action: {})
                        }
                    }
                    section("Options") {
                        VStack(spacing: 6) {
                            OptionRow("Quick", on: option == 0) { option = 0 }.driveID("kit-option-0")
                            OptionRow("Standard", on: option == 1, why: "Used by a plain line") { option = 1 }
                            OptionRow("Several", on: true, many: true, size: .sm) {}
                            OptionRow("Unboxed", on: false, boxed: false) {}
                        }
                        .frame(width: 360)
                    }
                    section("Progress") {
                        HStack(spacing: 32) {
                            Pager(count: 4, index: 1)
                            ThinkingDots()
                            ThinkingDots(label: "small", size: 3)
                            WaveText("Importing 2/5")
                            WaveText("Needs you", tone: .red)
                        }
                    }
                    section("Tabs") {
                        HStack(spacing: 0) {
                            FluidTab(on: false, sep: true) { TabTitle("Reading list"); TabClose {} }
                            FluidTab(on: true) { TabTitle("A very long note title that will not fit in a tab", weight: 500, color: Palette.ink); TabClose {} }
                            FluidTab(on: false, lifted: true) { TabTitle("Lifted") }
                        }
                        .padding(.horizontal, 12)
                        .background(Color(Palette.gray100))
                        TabCardView(title: "A very long note title that will not fit in a tab", detail: "Fellowship · Getting started")
                    }
                    section("Fields") {
                        HStack(spacing: 12) {
                            InlineField(placeholder: "Name the workspace", autoFocus: false, onCommit: { committed = $0 })
                                .driveID("kit-inline-field")
                            Text(committed).driveID("kit-committed")
                            EButton("Panel", .outline, size: .sm) { panel.toggle() }
                                .driveID("kit-panel")
                                .floatingPanel(isPresented: $panel, options: FloatingOptions(cap: 200, width: 240)) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        ForEach(0..<20, id: \.self) { i in Text("Row \(i)").padding(.horizontal, 12).frame(height: 28).hover(.wash) }
                                    }
                                    .padding(5)
                                    .driveID("kit-panel-list")
                                }
                            TooltipFace("Next agent needing attention", key: "⌃1", shortcut: "⌘J")
                        }
                    }
                    section("Icons") {
                        let icons: [Icon] = [KindIcons.note, KindIcons.file, KindIcons.doc, KindIcons.html, KindIcons.pdf, KindIcons.gh, KindIcons.folder,
                                             KindIcons.globe, KindIcons.layers, KindIcons.chat, KindIcons.task, KindIcons.workspace, KindIcons.image,
                                             KindIcons.code, KindIcons.search, KindIcons.expand, KindIcons.collapse, PhosphorIcons.shapesBold]
                        HStack(spacing: 10) { ForEach(Array(icons.enumerated()), id: \.offset) { _, icon in IconView(icon, size: 16) } }
                        let sidebar: [Icon] = [SidebarIcons.inbox, SidebarIcons.inboxDot, SidebarIcons.agents, SidebarIcons.connections, SidebarIcons.library,
                                               SidebarIcons.add, SidebarIcons.project, SidebarIcons.workspace, SidebarIcons.search, SidebarIcons.chevronDown,
                                               SidebarIcons.chevronRight, SidebarIcons.link, SidebarIcons.note, SidebarIcons.folder, SidebarIcons.star,
                                               SidebarIcons.starFilled, SidebarIcons.code, SidebarIcons.gear, SidebarIcons.panelClose, SidebarIcons.panelOpen,
                                               SidebarIcons.plus, SidebarIcons.paperclip, SidebarIcons.check, SidebarIcons.close, SidebarIcons.minusCircle,
                                               SidebarIcons.trash, SidebarIcons.archive, SidebarIcons.chat, SidebarIcons.pencil, SidebarIcons.external,
                                               SidebarIcons.sticky(), SidebarIcons.sticky(hidden: true), SidebarIcons.dots, SidebarIcons.compose,
                                               SidebarIcons.clock, SidebarIcons.image, SidebarIcons.globe, SidebarIcons.paper, SidebarIcons.git,
                                               SidebarIcons.arrowOut, SettingsIcons.model, SettingsIcons.blocks, SettingsIcons.add, SettingsIcons.flask,
                                               SettingsIcons.gear]
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 18, maximum: 18), spacing: 10)], alignment: .leading, spacing: 10) { ForEach(Array(sidebar.enumerated()), id: \.offset) { _, icon in IconView(icon) } }.frame(width: 560)
                        HStack(spacing: 8) { FolderPlusIcon(); KindGlyph("pdf"); KindGlyph("website", box: 18); GlyphBox { Text("@") } }
                    }
                    section("Settings rows") {
                        SettingsGroup("Claude Code", note: { Text("Signed in").foregroundStyle(Color(Palette.fnt)) }) {
                            SettingsRow("Quick") {
                                SettingsChoice("model", value: "sonnet", options: [.init(value: "sonnet", label: "Sonnet"), .init(value: "opus", label: "Opus")], width: 96) { _ in }
                            }
                            SettingsRow("Reveal in Finder", icon: SettingsIcons.flask, hint: "Open the test folder") {
                                Button("Reveal") {}.buttonStyle(SettingsButtonStyle())
                            }
                        }
                        .frame(width: 520)
                        .driveID("kit-settings-rows")
                        .padding(.leading, 16)
                    }
                }
                .padding(EdgeInsets(top: 12, leading: 32, bottom: 32, trailing: 32))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
        .driveID("screen=kit")
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).textStyle(.microcapLarge).foregroundStyle(Color(Palette.fnt))
            content()
        }
    }
}
