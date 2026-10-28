import AppKit
import EngelbartCore
import EngelbartIntegrations
import EngelbartStore
import EngelbartTools
import EngelbartUI
import SwiftUI

// Onboarding drawn (Onboarding.jsx's render). The window is white and the content sits on it, centred, with no card or
// grey boxes; one Continue per screen walks its parts (Hudson, 2026-09-28). Values are the JSX's, 1 CSS px = 1 pt.

enum OnboardingStyle {
    static let h1 = TextStyle(28, weight: 500, lineHeight: 1.2, tracking: -0.4)
    static let lead = TextStyle(15.5, lineHeight: 1.6)
    static let welcomeH1 = TextStyle(36, weight: 600, lineHeight: 1.15, tracking: -0.9)
    static let welcomeLead = TextStyle(18, lineHeight: 1.5)
    static let faint = TextStyle(13, lineHeight: 1.5)
    static let rise: TimeInterval = 0.26
    static let riseSub: TimeInterval = 0.22
    static let green = NSColor(hex: "#1f9d55")
    static let label = ["github": "GitHub", "url": "Websites", "pdf": "Papers"]
}

/// Welcome's picture width (2026-10-16, S1/S2: "this should be minimum size but should expand with window"): as large as the
/// window's height leaves room for, 300 to 640 wide. Not zoomed (d187c83).
public func welcomeWidth(window: CGSize) -> CGFloat {
    let room = min(window.height - 54 - 300, (window.width - 48) * (758 / 1199))
    return (max(300, min(640, room * (1199 / 758)))).rounded()
}

/// The onboarding screens. Rebuild it (a new model) when the app's `run` changes: a reset starts over.
public struct OnboardingScreen: View {
    @ObservedObject var model: OnboardingModel
    public init(model: OnboardingModel) { self.model = model }

    public var body: some View {
        GeometryReader { g in
            ZStack(alignment: .top) {
                Color(Palette.bg)
                if model.showsImportFlow {
                    importFlowPage
                } else {
                    flowPage(g.size)
                }
                if model.gate == .ask && model.step == "welcome", let slot = model.context.agentSetup {
                    slot(AgentSetupRequest(tools: model.tools, providers: model.agentProviders,
                                           onDone: { model.agentDone($0) }, onSkip: { model.agentSkip() }))
                }
            }
        }
        .task { await model.start() }
        .accessibilityElement(children: .contain)
        .probe("onboarding=\(model.flowMode.rawValue)")
    }

    /// "Engelbart" in the top left: back where onboarding was started from (all projects, or the guided setup's project).
    var titleBar: some View {
        HStack(spacing: 0) {
            if let back = model.context.onBack {
                Button(action: back) { Text("Engelbart").textStyle(.brand) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(Palette.ink))
                    .hover(.ink)
                    .help(model.context.backTitle)
                    .probe("onboarding-back", press: back)
            }
            Spacer(minLength: 0)
        }
        .padding(.trailing, 24)
        .titleLead(replacing: 24)
        .frame(height: TitleBarMetrics.header)
        .frame(maxWidth: .infinity)
        .titleBar()
    }

    // Import your context (2026-10-13) in place of Create and Connect your library: its own page across the window, the
    // title bar above it.
    @ViewBuilder var importFlowPage: some View {
        ZStack(alignment: .top) {
            if let slot = model.context.importFlow {
                slot(ImportFlowRequest(platform: model.context.platform,
                                       onDone: { made, extras in Task { await model.importDone(made, extras) } },
                                       renderLibrarian: { request in
                                           librarian(request)
                                       }))
            }
            titleBar
        }
        .accessibilityElement(children: .contain)
        .probe("step=import-context")
    }

    func librarian(_ request: LibrarianRequest) -> AnyView {
        guard let slot = model.context.connectLibrary else { return AnyView(EmptyView()) }
        return slot(ConnectLibraryRequest(sessionId: request.sessionId, project: request.project, pager: nil, onSession: { _ in },
                                          onContinue: request.onDone, onSkip: request.onDone, onBack: request.onBack,
                                          onAdded: { model.connectAdded($0) }))
    }

    @ViewBuilder func flowPage(_ size: CGSize) -> some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Color.clear.frame(height: 54)
                Group {
                    if model.step == "connect" {
                        connectPage
                    } else if model.step == "welcome" {
                        WelcomeScreen(model: model, window: size)
                            .padding(EdgeInsets(top: 8, leading: 24, bottom: 24, trailing: 24))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        // No card (2026-09-28): the same 800 × 600 at most, drawn on nothing, so lists inside still scroll
                        // and the page never does.
                        let box = CGSize(width: min(800, max(0, size.width - 48)), height: min(600, max(0, size.height - 78)))
                        CenteredScroll(height: box.height - 68) {
                            VStack(spacing: 24) {
                                stepBody
                                if let pager = model.pager, !model.place.detour { PagerRow(pager: pager) }
                            }
                        }
                        .padding(EdgeInsets(top: 40, leading: 32, bottom: 28, trailing: 32))
                        .frame(width: box.width, height: box.height)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(EdgeInsets(top: 0, leading: 24, bottom: 24, trailing: 24))
                    }
                }
            }
            titleBar
        }
        .accessibilityElement(children: .contain)
        .probe("step=\(model.step)")
    }

    @ViewBuilder var stepBody: some View {
        switch model.step {
        case "import": ImportScreen(model: model).id("import-\(model.sub)")
        case "instructions": InstructionsScreen(model: model)
        case "create": CreateScreen(model: model)
        case "context": ContextScreen(model: model)
        case "open":
            ThinkingDots(label: model.flowMode == .guided ? "opening Welcome" : "opening Getting started")
                .frame(maxWidth: .infinity)
                .probe("onboarding-opening")
        default: EmptyView()
        }
    }

    /// Connect your library: a page across the window (2026-10-08: "more horizontal … not a popup"), its foot its own.
    @ViewBuilder var connectPage: some View {
        VStack(spacing: 12) {
            if let slot = model.context.connectLibrary {
                slot(ConnectLibraryRequest(sessionId: model.connectId, project: model.librarianProject, pager: model.pager,
                                           onSession: { model.connectSession($0) }, onContinue: { model.advance() },
                                           onSkip: { model.connectSkip() }, onBack: nil, onAdded: { model.connectAdded($0) }))
            }
            ErrorLine(text: model.error)
        }
        .padding(EdgeInsets(top: 0, leading: 24, bottom: 24, trailing: 24))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .probe("connect-library-page")
    }
}

/// A scroll whose content sits centred while it fits and starts at the top once it does not (`justify-content: safe center`).
struct CenteredScroll<Content: View>: View {
    let height: CGFloat
    let content: Content
    init(height: CGFloat, @ViewBuilder content: () -> Content) { self.height = height; self.content = content() }
    var body: some View {
        ScrollView(.vertical) {
            content.frame(maxWidth: .infinity).frame(minHeight: max(0, height), alignment: .center)
        }
        .scrollIndicators(.automatic)
    }
}

/// The pager and "i of n".
struct PagerRow: View {
    let pager: PagerPosition
    var body: some View {
        HStack(spacing: 16) {
            Pager(count: pager.count, index: pager.index)
            Text("\(pager.index + 1) of \(pager.count)").textStyle(TextStyle(12, lineHeight: 1)).foregroundStyle(Color(Palette.fnt))
                .probe("onboarding-step-of")
        }
    }
}

struct ErrorLine: View {
    let text: String
    var body: some View {
        if !text.isEmpty {
            Text(text).textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.del)).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .probe("onboarding-error")
        }
    }
}

struct Head: View {
    let title: String
    let lead: String?
    var body: some View {
        VStack(spacing: 14) {
            Text(title).textStyle(OnboardingStyle.h1).foregroundStyle(Color(Palette.ink)).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if let lead {
                Text(lead).textStyle(OnboardingStyle.lead).foregroundStyle(Color(Palette.mut)).multilineTextAlignment(.center)
                    .frame(maxWidth: 440).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// An open circle that becomes a green check once the part holds something.
struct Mark: View {
    let done: Bool
    var body: some View {
        if done {
            Circle().fill(Color(OnboardingStyle.green)).frame(width: 18, height: 18)
                .overlay(Text("✓").font(Font(Fonts.sans(11, weight: 600))).foregroundStyle(Color.white))
                .probe("onboarding-mark=done")
        } else {
            Circle().strokeBorder(Color(Palette.bd2), lineWidth: 1.5).frame(width: 18, height: 18)
                .probe("onboarding-mark=open")
        }
    }
}

/// Skip (plain grey text, far left) and Continue (filled, ›, right): the same placement on every screen (S1).
struct Footer: View {
    let showSkip: Bool
    let onSkip: () -> Void
    let continueDisabled: Bool
    let label: String
    let onContinue: () -> Void
    var body: some View {
        HStack(spacing: 16) {
            if showSkip {
                Button(action: onSkip) { Text("Skip").font(Font(Fonts.sans(13, weight: 500))).padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(Palette.fnt))
                    .hover(.ink)
                    .padding(.leading, -12)
                    .probe("onboarding-skip", press: onSkip)
            }
            Spacer(minLength: 0)
            EButton(label, .filled, go: true, action: onContinue).disabled(continueDisabled)
                .probe("onboarding-continue", press: continueDisabled ? nil : onContinue)
        }
    }
}

/// A multi-line field with its placeholder (a textarea: focus-bd2, radius 8, the screen's type).
struct TextArea: View {
    @Binding var text: String
    let placeholder: String
    let font: NSFont
    let lineHeight: CGFloat
    let rows: Int
    let padding: EdgeInsets
    var id: String
    var onCommandReturn: (() -> Void)? = nil
    @FocusState private var focused: Bool

    var body: some View {
        let lineH = font.pointSize * lineHeight
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).font(Font(font)).foregroundStyle(Color(Palette.fnt)).italic()
                    .padding(.leading, 5).allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(Font(font))
                .lineSpacing(lineH - font.pointSize * 1.2)
                .scrollContentBackground(.hidden)
                .foregroundStyle(Color(Palette.ink))
                .focused($focused)
                .onKeyPress(keys: [.return]) { press in
                    if press.modifiers.contains(.command) || press.modifiers.contains(.control), let onCommandReturn { onCommandReturn(); return .handled }
                    return .ignored
                }
                .probe(id)
        }
        .frame(height: lineH * CGFloat(rows))
        .padding(padding)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.bg)))
        .hoverBorder(radius: Radius.sm, rest: Palette.bd, focused: focused)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }
}

// MARK: - Welcome

struct WelcomeScreen: View {
    @ObservedObject var model: OnboardingModel
    let window: CGSize

    var body: some View {
        let wide = welcomeWidth(window: window)
        VStack(spacing: 30) {
            VStack(spacing: 12) {
                Text("Welcome to Engelbart").textStyle(OnboardingStyle.welcomeH1).foregroundStyle(Color(Palette.ink)).multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text("The best way to brainstorm and create research projects").textStyle(OnboardingStyle.welcomeLead)
                    .foregroundStyle(Color(Palette.mut)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            Group {
                if let picture = Images.named("welcome-field") {
                    Image(nsImage: picture).resizable().aspectRatio(contentMode: .fill)
                } else {
                    Color(Palette.panel2)
                }
            }
            .frame(width: wide, height: (wide * 758 / 1199).rounded())
            .clipShape(RoundedRectangle(cornerRadius: Radius.md))
            .probe("welcome-picture")
            HStack(spacing: 16) {
                if let pager = model.pager { PagerRow(pager: pager) }
                Spacer(minLength: 0)
                Button { model.welcomeNext() } label: {
                    HStack(spacing: 6) { Text("Continue"); Text("›").font(Font(Fonts.sans(14))) }
                        .font(Font(Fonts.sans(15, weight: 500)))
                        .padding(EdgeInsets(top: 14, leading: 20, bottom: 14, trailing: 20))
                        .foregroundStyle(Color(model.gate == .checking ? Palette.fnt : Palette.onAcc))
                        .background(RoundedRectangle(cornerRadius: Radius.md).fill(Color(model.gate == .checking ? Palette.hov : Palette.ink)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hover(.dim, radius: Radius.md)
                .disabled(model.gate == .checking)
                .probe("onboarding-continue", press: model.gate == .checking ? nil : { model.welcomeNext() })
            }
        }
        .frame(width: wide)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .rise(OnboardingStyle.rise)
        // Enter on the welcome screen continues, as the design has it (not in a field, not on a button; not while asking).
        .background(KeyMonitor(keyCode: 36) {
            guard model.step == "welcome", model.gate == nil else { return false }
            if let responder = NSApp.keyWindow?.firstResponder, responder is NSTextView || responder is NSButton { return false }
            model.welcomeNext()
            return true
        })
        .accessibilityElement(children: .contain)
        .probe("welcome")
    }
}

// MARK: - Add to your library

struct ImportScreen: View {
    @ObservedObject var model: OnboardingModel
    @FocusState private var linkFocused: Bool

    var body: some View {
        let cur = model.part ?? "github"
        let items = model.addedHere(cur)
        let n = items.count // a repository the library already held is ticked in the list but not counted
        let status = model.context.github?.status
        let signedIn = cur == "github" && (status?.connected ?? false)
        let buttons = OnboardingFlow.importButtons(model.sub, n, signedIn: signedIn)
        VStack(spacing: 24) {
            Head(title: "Add to your library", lead: "Bring in the papers, websites, and code you've already read to conduct research. You can add more any time.")
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Mark(done: n > 0)
                    GlyphBox(16) { IconView(cur == "github" ? KindIcons.gh : cur == "url" ? KindIcons.globe : KindIcons.pdf, size: 16) }
                        .foregroundStyle(Color(Palette.mut))
                    Text(OnboardingStyle.label[cur] ?? "").textStyle(TextStyle(13.5, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !signedIn && n > 0 {
                        Text("\(n) added").textStyle(TextStyle(12, lineHeight: 1)).foregroundStyle(Color(Palette.fnt))
                    }
                    if signedIn, let status {
                        Text(status.login).textStyle(TextStyle(12.5, lineHeight: 1)).foregroundStyle(Color(Palette.mut))
                        Button("Sign out") { model.githubSignOut() }.buttonStyle(.plain)
                            .textStyle(TextStyle(12.5, lineHeight: 1)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                            .padding(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 0))
                            .probe("github-signout", press: { model.githubSignOut() })
                    }
                }
                .padding(EdgeInsets(top: 0, leading: 2, bottom: 12, trailing: 2))
                Group {
                    if cur == "github" {
                        if let github = model.context.github {
                            GithubReposView(model: github, held: { model.heldRepo($0) != nil }, onToggle: { repo in Task { await model.toggleRepo(repo) } },
                                            busyId: model.busy.isEmpty ? nil : model.busy)
                        } else {
                            Text("GitHub is not set up in this build.").textStyle(TextStyle(13, lineHeight: 1.6)).foregroundStyle(Color(Palette.fnt))
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    } else if cur == "url" {
                        urlPart(items)
                    } else {
                        pdfPart(items)
                    }
                }
                .frame(maxHeight: .infinity)
                if signedIn, let url = status?.installUrl, !url.isEmpty {
                    Button("Choose repositories in browser…") { model.githubInstall() }.buttonStyle(.plain)
                        .textStyle(TextStyle(13, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                        .padding(.top, 8)
                        .probe("github-install", press: { model.githubInstall() })
                }
            }
            .frame(minHeight: 180, idealHeight: 300, maxHeight: 300)
            if model.context.platform == "darwin" && model.context.importSignins != nil {
                Button("Bring over your sign-ins from another browser…") { model.importSignins() }.buttonStyle(.plain)
                    .textStyle(TextStyle(13, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                    .padding(.top, 2)
                    .probe("onboarding-import-signins", press: { model.importSignins() })
            }
            ErrorLine(text: model.error)
            Footer(showSkip: buttons.showSkip, onSkip: { model.advance() }, continueDisabled: buttons.continueDisabled, label: "Continue",
                   onContinue: { model.advance() })
        }
        .frame(maxWidth: 520)
        .rise(OnboardingStyle.rise)
        .accessibilityElement(children: .contain)
        .probe("part=\(cur)")
    }

    @ViewBuilder func urlPart(_ items: [LibraryRow]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(items, id: \.id) { row in
                        Text(row.name).textStyle(TextStyle(13.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.ink)).lineLimit(1).truncationMode(.tail)
                            .padding(.vertical, 4).help(row.url ?? "")
                    }
                    if items.isEmpty {
                        Text("nothing added yet…").textStyle(OnboardingStyle.faint).italic().foregroundStyle(Color(Palette.fnt)).padding(.vertical, 4)
                    }
                }
                .padding(EdgeInsets(top: 8, leading: 2, bottom: 8, trailing: 2))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .probe("onboarding-items")
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    TextField("", text: $model.entry, prompt: Text("paste a link…").italic().foregroundColor(Color(Palette.fnt)))
                        .textFieldStyle(.plain).font(Font(Fonts.sans(13.5))).foregroundStyle(Color(Palette.ink))
                        .disableAutocorrection(true)
                        .focused($linkFocused)
                        .disabled(model.busy == "url")
                        .onSubmit { Task { await model.addEntry() } }
                        .padding(.vertical, 6)
                        .probe("onboarding-link")
                    let live = !model.entry.trimmed.isEmpty && model.busy != "url"
                    Button(model.busy == "url" ? "Adding…" : "Add") { Task { await model.addEntry() } }.buttonStyle(.plain)
                        .textStyle(TextStyle(12.5, weight: 500, lineHeight: 1)).foregroundStyle(Color(live ? Palette.ink : Palette.bd2))
                        .padding(EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6))
                        .disabled(!live)
                        .probe("onboarding-link-add", press: { Task { await model.addEntry() } })
                }
                .padding(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 4))
                .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(Palette.bg)))
                .hoverBorder(radius: Radius.xs, rest: Palette.bd, focused: linkFocused)
                if !model.entryErr.isEmpty {
                    Text(model.entryErr).textStyle(TextStyle(12.5, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).padding(.horizontal, 2)
                        .probe("onboarding-entry-error")
                }
            }
            .padding(.top, 10)
        }
        .rise(OnboardingStyle.riseSub)
        .onAppear { DispatchQueue.main.async { linkFocused = true } }
        .onChange(of: model.focusLink) { _, _ in DispatchQueue.main.async { linkFocused = true } }
    }

    @ViewBuilder func pdfPart(_ items: [LibraryRow]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(items, id: \.id) { row in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(row.name).textStyle(TextStyle(13.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.ink)).lineLimit(1).truncationMode(.tail)
                            Text(OnboardingFlow.rowWhy(row)).textStyle(TextStyle(12, lineHeight: 1.5)).foregroundStyle(Color(Palette.fnt)).fixedSize()
                        }
                        .padding(.vertical, 4)
                    }
                    if items.isEmpty {
                        Text("nothing added yet…").textStyle(OnboardingStyle.faint).italic().foregroundStyle(Color(Palette.fnt)).padding(.vertical, 4)
                    }
                }
                .padding(EdgeInsets(top: 8, leading: 2, bottom: 8, trailing: 2))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .probe("onboarding-items")
            Button { Task { await model.pickPapers() } } label: {
                Text(model.busy == "pdf" ? "adding…" : items.isEmpty ? "choose papers…" : "add more papers…")
                    .textStyle(TextStyle(13.5, lineHeight: 1.4)).italic().foregroundStyle(Color(Palette.fnt))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                    .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(Palette.bg)))
                    .hoverBorder(radius: Radius.xs)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy == "pdf")
            .padding(.top, 10)
            .probe("onboarding-pick-papers", press: { Task { await model.pickPapers() } })
        }
        .rise(OnboardingStyle.riseSub)
    }
}

// MARK: - Custom instructions

struct InstructionsScreen: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        let empty = model.instr.trimmed.isEmpty
        VStack(spacing: 16) {
            Head(title: "Custom instructions", lead: "Tell Engelbart about your research and occupation.").padding(.bottom, 6)
            HStack(spacing: 8) {
                OptionRow("Import from an AI provider", on: model.instrSrc == "claude") { model.chooseInstructions("claude") }
                    .probe("option=import", press: { model.chooseInstructions("claude") })
                OptionRow("Write my own", on: model.instrSrc == "own") { model.chooseInstructions("own") }
                    .probe("option=own", press: { model.chooseInstructions("own") })
            }
            if model.instrSrc == "claude" {
                HStack(spacing: 12) {
                    Text("Copy the prompt, paste it into Claude or ChatGPT, then paste the reply below.").textStyle(TextStyle(13, lineHeight: 1.45))
                        .foregroundStyle(Color(Palette.mut)).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    EButton(model.copied ? "Copied ✓" : "Copy prompt", .outline, size: .sm) { model.copyPrompt() }
                        .probe("onboarding-copy-prompt", press: { model.copyPrompt() })
                }
                .padding(.horizontal, 2)
            }
            if let src = model.instrSrc {
                TextArea(text: $model.instr, placeholder: src == "own" ? "e.g. I’m a PhD student in HCI. Explain methods before results. Cite sources…" : "paste the reply here…",
                         font: Fonts.sans(14), lineHeight: 1.6, rows: 4, padding: EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14),
                         id: "onboarding-instructions")
            }
            ErrorLine(text: model.error)
            Footer(showSkip: empty, onSkip: { model.advance() }, continueDisabled: empty, label: "Continue",
                   onContinue: { Task { await model.saveInstructions() } })
                .padding(.top, 4)
        }
        .frame(maxWidth: 520)
        .rise(OnboardingStyle.rise)
    }
}

// MARK: - Create a new project

struct CreateScreen: View {
    @ObservedObject var model: OnboardingModel
    @FocusState private var nameFocused: Bool

    var body: some View {
        let buttons = model.createButtons
        VStack(spacing: 24) {
            Head(title: "Create a new project", lead: "Projects let you organize all of the citations, websites, papers, and code for your research without anything getting lost.")
            VStack(alignment: .leading, spacing: 0) {
                if model.part == "name" {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Project name").textStyle(TextStyle(14, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                        TextField("", text: $model.name, prompt: Text("e.g. Teachable agents for debugging").italic().foregroundColor(Color(Palette.fnt)))
                            .textFieldStyle(.plain).font(Font(Fonts.sans(15.5))).foregroundStyle(Color(Palette.ink))
                            .disableAutocorrection(true)
                            .focused($nameFocused)
                            .onSubmit { Task { await model.createNext() } }
                            .padding(EdgeInsets(top: 11, leading: 14, bottom: 11, trailing: 14))
                            .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.bg)))
                            .hoverBorder(radius: Radius.sm, rest: Palette.bd, focused: nameFocused)
                            .probe("onboarding-name")
                        // The folder part is gone (2026-10-09): a folder is made at ~/<name>, unless one is picked here.
                        if model.folder == "existing" && !model.folderPath.isEmpty {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(model.folderPath).font(Font(Fonts.mono(12.5))).foregroundStyle(Color(Palette.ink))
                                    .probe("onboarding-folder-path")
                                QuietLink(title: "Create a folder for me instead", id: "onboarding-new-folder") { model.useNewFolder() }
                            }
                            .padding(.horizontal, 2)
                        } else {
                            QuietLink(title: "Use an existing folder…", id: "onboarding-use-folder") { Task { await model.browseFolder() } }
                                .help(model.newPath.isEmpty ? "" : "Otherwise a folder is made at \(model.newPath)")
                                .padding(.horizontal, 2)
                        }
                    }
                    .rise(OnboardingStyle.riseSub)
                    .onAppear { DispatchQueue.main.async { nameFocused = true } }
                } else if model.part == "desc" {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Project description").textStyle(TextStyle(14, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                        TextArea(text: $model.desc, placeholder: "what you're studying, and what done looks like…", font: Fonts.sans(15), lineHeight: 1.6, rows: 3,
                                 padding: EdgeInsets(top: 11, leading: 14, bottom: 11, trailing: 14), id: "onboarding-desc",
                                 onCommandReturn: { Task { await model.createNext() } })
                    }
                    .rise(OnboardingStyle.riseSub)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 150)
            ErrorLine(text: model.error)
            Footer(showSkip: buttons.showSkip, onSkip: { Task { await model.createNext() } }, continueDisabled: buttons.continueDisabled,
                   label: buttons.label, onContinue: { Task { await model.createNext() } })
        }
        .frame(maxWidth: 520)
        .rise(OnboardingStyle.rise)
        .accessibilityElement(children: .contain)
        .probe("part=\(model.part ?? "")")
    }
}

/// A quiet underlined link (12.5px #8f8f8f, offset 3), ink on hover.
struct QuietLink: View {
    let title: String
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) { Text(title).textStyle(TextStyle(12.5, lineHeight: 1.5)).underline(true) }
            .buttonStyle(.plain)
            .foregroundStyle(Color(Palette.fnt))
            .hover(.ink)
            .probe(id, press: action)
    }
}

// MARK: - Project context

struct ContextScreen: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        let rows = model.contextRows
        let nSel = rows.filter { model.sel[$0.id] == true }.count
        let allOn = !rows.isEmpty && nSel == rows.count
        VStack(spacing: 28) {
            Head(title: "Project context", lead: "Choose what from your library \(model.projectName) should know about.")
            if !rows.isEmpty {
                VStack(spacing: 8) {
                    HStack {
                        Text("\(nSel) of \(rows.count) selected").textStyle(.microcapLarge).tracking(1.4).foregroundStyle(Color(Palette.fnt))
                            .probe("onboarding-selected")
                        Spacer(minLength: 0)
                        EButton(allOn ? "Select none" : "Select all", .link) { model.toggleAll() }
                    }
                    .padding(.horizontal, 2)
                    ScrollView(.vertical) {
                        VStack(spacing: 8) {
                            ForEach(rows, id: \.id) { row in
                                OptionRow(row.name, on: model.sel[row.id] == true, many: true, why: OnboardingFlow.rowWhy(row)) { model.toggle(row.id) }
                                    .probe("option=\(row.id)", press: { model.toggle(row.id) })
                            }
                        }
                    }
                    .frame(maxHeight: 272)
                    .fixedSize(horizontal: false, vertical: true)
                    .probe("onboarding-context")
                }
            } else {
                VStack(spacing: 10) {
                    Text("Your library is empty.").textStyle(TextStyle(14, lineHeight: 1.6)).foregroundStyle(Color(Palette.mut))
                    EButton("Add to library", .link, go: true) { model.addToLibraryDetour() }.probe("onboarding-add-to-library", press: { model.addToLibraryDetour() })
                }
                .padding(EdgeInsets(top: 32, leading: 24, bottom: 32, trailing: 24))
            }
            ErrorLine(text: model.error)
            EButton("Open project", .filled, go: true) { Task { await model.open() } }
                .padding(.top, 8)
                .probe("onboarding-open", press: { Task { await model.open() } })
        }
        .frame(maxWidth: 520)
        .rise(OnboardingStyle.rise)
    }
}

/// Onboarding as an AppKit controller (an NSHostingController of `OnboardingScreen`). Make a new one when the app's `run`
/// changes (a reset starts onboarding over from its first screen).
@MainActor
public final class OnboardingViewController: NSHostingController<AnyView> {
    public let model: OnboardingModel
    public init(context: OnboardingContext, tools: ToolsSnapshot? = nil, chrome: WindowChrome = WindowChrome()) {
        let model = OnboardingModel(context: context, tools: tools)
        self.model = model
        super.init(rootView: AnyView(OnboardingScreen(model: model).environmentObject(chrome)))
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a coder") }
}
