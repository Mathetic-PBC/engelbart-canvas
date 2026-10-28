import AppKit
import SwiftUI
import EngelbartCore
import EngelbartConnect
import EngelbartUI

// Import your context's screens and dialogs (src/renderer/import/ImportFlow.jsx, drawn to the onboarding mockup's CSS):
// intro → roles → work → projects → the picker, with the dialogs over them. A new user's onboarding draws it across the
// window (pages 72 from the top); over a workspace it is the modal's content. Identifiers follow the data-* attributes
// (`data-import-screen="picker"` → `import-screen=picker`).

public struct ImportFlowView: View {
    @ObservedObject var model: ImportFlowModel
    /// The librarian's chat (Import manually, in a new user's onboarding): Connect your library's page.
    let librarian: ((_ sessionId: String, _ project: (name: String, description: String), _ onDone: @escaping () -> Void, _ onBack: @escaping () -> Void) -> AnyView)?
    @State private var recommendedFits = true

    public init(model: ImportFlowModel, librarian: ((String, (name: String, description: String), @escaping () -> Void, @escaping () -> Void) -> AnyView)? = nil) {
        self.model = model; self.librarian = librarian
    }

    var F: FlowState { model.state }
    var fluid: Bool { model.mode == .new }

    public var body: some View {
        ZStack {
            Color.white
            if F.screen == "librarian", let id = F.librarian {
                librarianScreen(id)
            } else {
                screen.disabled(F.dialog != nil)
                if let dialog = F.dialog { dialogLayer(dialog) }
                if !model.error.isEmpty { errorLine }
            }
        }
        .driveID("import-flow=\(model.mode.rawValue)")
    }

    @ViewBuilder var screen: some View {
        switch F.screen {
        case "intro": introPage
        case "roles": rolesPage
        case "work": workPage
        case "projects": projectsPage
        default: pickerPage
        }
    }

    // MARK: the librarian

    func librarianScreen(_ id: String) -> some View {
        VStack(spacing: 10) {
            if let librarian {
                librarian(id, model.librarianProject, { Task { await model.librarianDone() } }, { model.librarianBack() })
            } else {
                ConnectLibraryHost(api: model.api, context: {
                    var context = ConnectLibraryContext(mode: .onboarding, sessionId: id, project: model.librarianProject)
                    context.onContinue = { Task { await model.librarianDone() } }
                    context.onBack = { model.librarianBack() }
                    return context
                }())
            }
            if !model.error.isEmpty { Text(model.error).font(IX.font(12.5, 400)).foregroundStyle(IX.red) }
        }
        .padding(.top, 54).padding(.horizontal, 24).padding(.bottom, 24)
        .driveID("import-screen=librarian")
    }

    // MARK: intro

    var introPage: some View {
        let copy = ImportFlowState.copy
        let row = CGFloat(10 * 52 + 9 * 10)
        return ZStack(alignment: .topTrailing) {
            VStack(spacing: 0) {
                Spacer(minLength: 48)
                Text(copy["title"]!).font(IX.font(34, 650)).tracking(-1).foregroundStyle(IX.ink).padding(.bottom, 14)
                Text(copy["subtitle"]!).font(IX.font(15, 400)).foregroundStyle(IX.body).multilineTextAlignment(.center).lineSpacing(15 * 0.6 - 4)
                    .frame(maxWidth: 530).padding(.bottom, 30)
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(52), spacing: 10), count: 10), spacing: 10) {
                    ForEach(ImportFlowState.supported, id: \.name) { one in
                        LogoImage(file: one.file, size: 26).frame(width: 52, height: 52)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(IX.line, lineWidth: 1))
                            .help(one.name)
                    }
                }
                .frame(maxWidth: row).padding(.bottom, 36)
                HStack {
                    Button(action: { model.state.dialog = "scratch-confirm" }) { Text(copy["secondary"]!).font(IX.font(13, 400)).underline().foregroundStyle(IX.mute) }
                        .buttonStyle(.plain).driveID("import-skip")
                    Spacer()
                    IXButton(copy["primary"]!, width: 270, id: "import-start") { Task { await model.importContext() } }
                }
                .frame(maxWidth: row)
                Spacer(minLength: 48)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            if model.mode == .modal {
                Button(action: { Task { await model.close() } }) { Text("×").font(IX.font(22, 400)).foregroundStyle(IX.mute) }
                    .buttonStyle(.plain).padding(18).driveID("import-close")
            }
        }
        .driveID("import-screen=intro")
    }

    // MARK: the work questions

    func head(_ title: String, _ sub: String = "", size: CGFloat = 30) -> some View {
        VStack(spacing: 8) {
            Text(title).font(IX.font(size, 600)).tracking(-0.8).foregroundStyle(IX.ink).multilineTextAlignment(.center)
            if !sub.isEmpty { Text(sub).font(IX.font(14, 400)).foregroundStyle(IX.mute) }
        }
        .frame(maxWidth: .infinity).padding(.bottom, 24)
    }

    var lowerBack: some View {
        Button(action: { model.back() }) {
            HStack(spacing: 6) { Glyph(IXGlyph.chevron, size: 12).rotationEffect(.degrees(180)); Text("Back") }.font(IX.font(13, 400)).foregroundStyle(IX.mute)
        }
        .buttonStyle(.plain).frame(minHeight: 40).driveID("work-back")
    }

    func continueButton(_ disabled: Bool, _ action: @escaping () -> Void) -> some View {
        IXButton("Continue", size: 14, disabled: disabled, chevron: true, id: "work-continue", action: action)
    }

    var rolesPage: some View {
        page(width: 640) {
            head("What kind of work do you do?", "Choose all that apply.")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(ImportFlow.roles, id: \.name) { role in
                    let on = F.roles.contains(role.name)
                    Button(action: { model.toggleRole(role.name) }) {
                        HStack(spacing: 7) {
                            Glyph(role.paths, size: 18, width: 1.45).foregroundStyle(hex("#383838"))
                            Text(role.name).font(IX.font(14, 400)).foregroundStyle(IX.ink).lineLimit(1)
                            Spacer(minLength: 0)
                            IXCheck(on: on, size: 16)
                        }
                        .padding(10).frame(maxWidth: .infinity, minHeight: 60)
                        .background(RoundedRectangle(cornerRadius: 10).fill(on ? IX.wash : Color.white))
                        .chosen(on)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).driveID("work-role=\(role.name)")
                }
            }
            HStack { lowerBack; Spacer(); continueButton(F.roles.isEmpty) { model.rolesContinue() } }.padding(.top, 24)
        }
        .driveID("import-screen=roles")
    }

    var workPage: some View {
        page(width: 560) {
            head("What are you interested in researching?")
            GrowingField("Understanding the Memex...", text: Binding(get: { model.state.work }, set: { model.setWork($0) }), size: 15, id: "work-description") { model.workNext() }
                .frame(width: 390)
            HStack { lowerBack; Spacer(); continueButton(F.work.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { model.workNext() } }.frame(width: 390).padding(.top, 24)
        }
        .driveID("import-screen=work")
    }

    var projectsPage: some View {
        let status = model.projectStatus
        let ready = status == "done" || status == "failed"
        return page(width: 640) {
            head("What project do you want to work on first?", "Select one or more projects, or add your own.")
            VStack(spacing: 8) {
                ForEach(model.projects, id: \.id) { project in
                    let on = F.picked.contains(project.id)
                    Button(action: { model.toggleProject(project.id) }) {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.title).font(IX.font(14, 500)).foregroundStyle(IX.ink)
                                Text(project.description.isEmpty ? "Added by you" : project.description).font(IX.font(12, 400)).foregroundStyle(IX.mute).lineSpacing(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            if !project.recent.isEmpty { Text(project.recent).font(IX.font(12, 400)).foregroundStyle(IX.mute) }
                            IXCheck(on: on)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 64)
                        .background(RoundedRectangle(cornerRadius: 10).fill(on ? IX.wash : Color.white))
                        .chosen(on)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).driveID("work-project=\(project.id)")
                }
                if !ready {
                    VStack(spacing: 0) {
                        discoveryLine
                        ForEach(0..<2, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: 10).fill(LinearGradient(colors: [hex("#fafafa"), hex("#f5f5f5"), hex("#fafafa")], startPoint: .leading, endPoint: .trailing))
                                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1)).frame(height: 62).padding(.top, 12)
                        }
                    }
                    .padding(.top, 8)
                }
                if ready && status == "failed" { discoveryLine }
                if status == "done" && J.truthy(model.discovery?["projects"]?["empty"]) && model.projects.isEmpty {
                    Text("Add the project you want to start with.").font(IX.font(14, 400)).foregroundStyle(IX.body).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                        .driveID("projects-empty")
                }
            }
            Button(action: { model.openAddProject() }) {
                HStack(spacing: 10) { Glyph(IXGlyph.plus, size: 16); Text("Add a project") }.font(IX.font(14, 400)).foregroundStyle(hex("#666666"))
                    .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: 14 * 1.45 + 12 * 1.55 + 28, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line2, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.top, 10).driveID("add-project")
            HStack(spacing: 16) {
                lowerBack
                Text("\(F.picked.count) selected").font(IX.font(12.5, 400)).foregroundStyle(IX.mute)
                Spacer()
                continueButton(F.picked.isEmpty) { model.projectsContinue() }
            }
            .padding(.top, 24)
        }
        .driveID("import-screen=projects")
    }

    @ViewBuilder var discoveryLine: some View {
        if let line = model.discoveryLine {
            HStack(spacing: 8) {
                Circle().fill(IX.grey).frame(width: 6, height: 6)
                Text(line.text).font(IX.font(12.5, 400)).foregroundStyle(IX.mute)
                Spacer()
                if let connect = line.connect { IXButton(connect, .under, size: 12, id: "discovery-connect") { Task { await model.discoveryConnect() } } }
                if line.tryAgain { IXButton("Try again", .under, size: 12, id: "discovery-again") { Task { await model.discoveryAgain() } } }
            }
            .frame(minHeight: 24).padding(.top, 22)
            .driveID("discovery-status=\(line.status)")
        }
    }

    func page<Content: View>(width: CGFloat, @ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            VStack(spacing: 0) { content() }
                .frame(width: width)
                .padding(.top, fluid ? 72 : 72).padding(.bottom, 40)
                .frame(maxWidth: .infinity)
        }
    }

    // MARK: the picker

    var pickerPage: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                Text(ImportFlowState.copy["pickerTitle"]!).font(IX.font(33, 500)).tracking(-0.8).foregroundStyle(IX.ink).padding(.bottom, 28)
                if model.mode == .new && model.toolStatus == "checking" {
                    HStack(spacing: 8) { Circle().fill(IX.grey).frame(width: 6, height: 6); Text("Finding the tools you use…").font(IX.font(12.5, 400)).foregroundStyle(IX.mute); Spacer() }
                        .padding(.bottom, 16).driveID("tools-status=checking")
                }
                AlwaysScroll {
                    VStack(alignment: .leading, spacing: 0) {
                        if !ImportFlowState.recommended.isEmpty { pickerSection("recommended", "Recommended", ImportFlowState.recommended, where_: "recommended") }
                        ForEach(ImportFlow.groups.filter { !model.keysOf($0).isEmpty }, id: \.id) { group in
                            pickerSection(group.id, group.label, model.keysOf(group), where_: "home")
                        }
                        HStack { Spacer(); IXButton("+ Add a tool", .under, size: 13, id: "add-tool") { model.openAddTool() } }.padding(.top, 16).padding(.bottom, 8)
                    }
                    .padding(.trailing, 12)
                }
                .padding(.trailing, -22)
            }
            .frame(maxWidth: 680)
            .padding(.top, 72).padding(.horizontal, 24)
            pickerFoot
        }
        .driveID("import-screen=picker")
    }

    func pickerSection(_ id: String, _ label: String, _ keys: [String], where_: String) -> some View {
        let n = keys.filter(model.isPicked).count
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(label).font(IX.font(16, 500)).foregroundStyle(IX.ink).driveID("group=\(id)")
                Spacer()
                Text(n > 0 ? "\(n) selected" : "").font(IX.font(12, 400)).foregroundStyle(IX.mute)
            }
            .frame(height: 40)
            ForEach(keys, id: \.self) { key in sourceRow(key, where_: where_) }
        }
        .driveID("group-section=\(id)")
    }

    func sourceRow(_ id: String, where_: String) -> some View {
        let selected = model.isPicked(id)
        let open = model.specifyOpen(id, where_)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Button(action: { model.pickSource(id) }) {
                    HStack(spacing: 12) {
                        ToolLogo(id: id)
                        Text(model.nameOf(id)).font(IX.font(15, 400)).foregroundStyle(IX.ink).frame(maxWidth: .infinity, alignment: .leading)
                        IXCheck(on: selected)
                    }
                    .frame(minHeight: 52).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .driveID(where_ == "recommended" ? "recommended=\(id)" : "app=\(id)")
                if selected {
                    Button(action: { model.toggleSpecify(id, where_) }) {
                        HStack(spacing: 6) { Text("Specify context"); Glyph(IXGlyph.down, size: 12).rotationEffect(.degrees(open ? 180 : 0)) }
                            .font(IX.font(12, 400)).foregroundStyle(hex("#777777")).padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                    .driveID(where_ == "recommended" ? "recommended-specify=\(id)" : "specify-context=\(id)")
                }
            }
            .padding(.horizontal, 12)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? IX.wash : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected ? IX.ink : Color.clear, lineWidth: 1.5))
            if open { contextPanel(id).padding(.top, 14).padding(.bottom, 22) }
        }
        .padding(.vertical, 3)
    }

    /// A source's own Specify context (round 3, reworked 2026-10-14; From Amitav 2026-10-15).
    func contextPanel(_ id: String) -> some View {
        let scope = model.scopeOf(id)
        let name = model.spokenOf(id)
        let chosen = model.chosen
        return VStack(alignment: .leading, spacing: 0) {
            if !chosen.isEmpty {
                Text("Select all projects you want Engelbart to import from \(name).").font(IX.font(12, 400)).foregroundStyle(hex("#777777")).padding(.bottom, 10)
                FlowRow(spacing: 6) {
                    ForEach(chosen, id: \.id) { project in
                        let on = model.sourceProjectOn(id, project.id)
                        Button(action: { model.toggleSourceProject(id, project.id) }) {
                            HStack(spacing: 5) { if on { Text("✓").foregroundStyle(IX.blue) }; Text(project.title) }
                                .font(IX.font(12, 400)).foregroundStyle(IX.ink).padding(.horizontal, 9).padding(.vertical, 5)
                                .background(RoundedRectangle(cornerRadius: 6).fill(on ? IX.wash : Color.white))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(on ? IX.ink : hex("#dddddd"), lineWidth: 1))
                        }
                        .buttonStyle(.plain).driveID("source-project=\(project.id)")
                    }
                }
            }
            Text("Specific things to import from \(name) (optional)").font(IX.font(13, 500)).foregroundStyle(IX.body).padding(.top, chosen.isEmpty ? 6 : 22).padding(.bottom, 10)
            GrowingField(ImportFlowState.groupHints[ImportFlowState.groupOfId(id, F)] ?? "", text: Binding(get: { model.scopeOf(id).note }, set: { value in model.setScope(id) { $0.note = String(value.prefix(2000)) } }),
                         id: "scope-note=\(id)")
            if scope.kind == "email" {
                HStack(spacing: 14) {
                    IXField("Name or email address", text: Binding(get: { model.sender[id] ?? "" }, set: { model.sender[id] = $0 }), id: "sender-input=\(id)") { model.addPerson(id) }
                    IXButton("Add person", .link, size: 12.5) { model.addPerson(id) }
                }
                .padding(.top, 10)
                if !scope.people.isEmpty {
                    FlowRow(spacing: 6) {
                        ForEach(scope.people, id: \.self) { person in
                            Button(action: { model.setScope(id) { $0.people.removeAll { $0 == person } } }) { Text("\(person) ×").font(IX.font(12, 400)).foregroundStyle(IX.ink) }.buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 10)
                }
            }
            if ImportFlowState.fileSources.contains(id) {
                IXButton("Choose files", .under, size: 12, id: "choose-files=\(id)") { Task { await model.chooseFiles(id) } }.padding(.top, 12)
            }
            if !scope.folders.isEmpty {
                FlowRow(spacing: 6) {
                    ForEach(scope.folders, id: \.path) { folder in
                        HStack(spacing: 6) {
                            Glyph(folder.file ? IXGlyph.file : IXGlyph.folder, size: 13).foregroundStyle(IX.mute)
                            Text(folder.name).font(IX.font(12, 400)).foregroundStyle(IX.ink)
                            Button(action: { model.setScope(id) { $0.folders.removeAll { $0.path == folder.path } } }) { Text("×").foregroundStyle(IX.mute) }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 4).help(folder.path)
                        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(IX.line, lineWidth: 1))
                    }
                }
                .padding(.top, 8)
            }
        }
        .padding(.leading, 47).padding(.trailing, 14)
        .driveID("context-panel=\(id)")
    }

    var pickerFoot: some View {
        HStack(spacing: 18) {
            IXButton(model.mode == .modal ? "Cancel" : "Back", .link, id: "picker-back") { Task { await model.pickerBack() } }
            Spacer()
            Text("\(F.picks.count) selected").font(IX.font(12, 400)).foregroundStyle(IX.mute)
            IXButton(model.busy == "run" ? "Starting…" : ImportFlowState.runLabel, size: 15, disabled: F.picks.isEmpty || F.picked.isEmpty || model.busy == "run", chevron: model.busy != "run", id: "import-run") {
                Task { await model.chooseMethod() }
            }
        }
        .frame(maxWidth: 680).frame(height: 82).padding(.horizontal, 24)
        .frame(maxWidth: .infinity).background(Color.white)
    }

    // MARK: the dialogs

    func dialogLayer(_ d: String) -> some View {
        let width: CGFloat = ["obsidian-picker": 540, "organize": 480, "tools-setup": 440, "safari": 540, "import-method": 560][d] ?? 486
        let padding: CGFloat = d == "obsidian-picker" ? 22 : 26
        return Scrim(onPress: { model.scrimPressed() }) {
            IXModal(width: width, padding: padding) { dialogBody(d) }
                .driveID("dialog=\(d)")
        }
        .background(KeyMonitor(keyCode: 53) { if !ImportFlowState.unskippable.contains(d) { model.state.dialog = nil; return true }; return false })
    }

    @ViewBuilder func dialogBody(_ d: String) -> some View {
        switch d {
        case "scratch-confirm":
            IXTitle("Are you sure?")
            IXPara(model.mode == .modal ? "Nothing will be imported. You can import your context later." : "Your project will start with an empty library. You can import your context later.")
            IXFoot {
                IXButton(model.mode == .modal ? "Close" : "Skip", .link, id: "scratch-skip") { if model.mode == .modal { Task { await model.startFromScratch() } } else { model.state.dialog = "project" } }
                IXButton("Keep importing", small: true, id: "scratch-keep") { Task { await model.importContext() } }
            }
        case "project":
            IXTitle("Create a new project")
            IXPara("Start with an empty library. You can import context later.")
            label("Project name")
            IXField("My research project", text: Binding(get: { model.state.scratchName }, set: { model.state.scratchName = String($0.prefix(200)) }), id: "project-name") { Task { await model.startFromScratch() } }.padding(.top, 7)
            HStack(spacing: 4) { label("Description"); Text("(optional)").font(IX.font(13, 400)).foregroundStyle(IX.mute).padding(.top, 20) }
            GrowingField("What are you working on?", text: Binding(get: { model.state.scratchDesc }, set: { model.state.scratchDesc = String($0.prefix(4000)) }), id: "project-desc").padding(.top, 7)
            IXFoot {
                IXButton("Back", .link) { model.state.dialog = "scratch-confirm" }
                IXButton(model.busy == "project" ? "Creating…" : "Create project", small: true, disabled: F.scratchName.trimmingCharacters(in: .whitespaces).isEmpty || model.busy == "project", id: "project-create") { Task { await model.startFromScratch() } }
            }
        case "provider-choice":
            IXTitle("Which provider should Engelbart use for onboarding?")
            VStack(spacing: 7) {
                ForEach(model.providerChoices, id: \.self) { id in
                    choiceRow(on: false, id: "onboarding-provider=\(id)", action: { Task { await model.chooseProvider(id) } }) {
                        LogoImage(file: Logos.providerFiles[id], size: 26); Text(id == "anthropic" ? "Claude" : "Codex").font(IX.font(15, 400)); Spacer()
                    }
                }
            }.padding(.top, 16)
            HStack { IXButton("Back", .link) { model.state.dialog = nil }; Spacer() }.padding(.top, 22)
        case "tools-setup":
            if let popup = model.agentSetup { AgentSetupBody(model: popup) }
        case "import-method": methodDialog
        case "agents-consent":
            IXTitle("Import context using background agents")
            IXPara(model.agentsConsentText)
            IXFoot(gap: 12) {
                IXButton("Back", .link) { model.state.dialog = "import-method" }
                Spacer()
                IXButton("Import manually", .secondary, small: true, id: "import-manually") { Task { await model.manually() } }
                IXButton("I understand", small: true, id: "import-understood") { Task { await model.understood() } }
            }
        case "keychain":
            if model.browsers == nil {
                IXTitle("Allow Engelbart to use your browser sign-ins")
                Text("Looking for your browsers…").font(IX.font(14, 400)).foregroundStyle(IX.mute).padding(.top, 16).driveID("keychain-looking")
            } else {
                let asking = model.busy == "keychain"
                IXTitle("Allow Engelbart to use your \(model.browserNow) sign-ins")
                IXPara("Everything is stored locally on your own device.")
                IXFoot {
                    IXButton("Use another browser", .under, disabled: asking) { model.state.browserFrom = "keychain"; model.state.browserChoice = model.browsers?["chosenId"]?.string; model.state.dialog = "keychain-browser" }
                    IXButton(asking ? "Waiting for macOS…" : "Allow", small: true, disabled: asking, id: "import-keychain-allow") { Task { await model.keychainAllow() } }
                }
            }
        case "safari":
            let waiting = F.diskWaiting || model.busy == "keychain"
            IXTitle("Engelbart requires additional permissions to access Safari")
            IXPara("Click on the toggle next to ‘Engelbart’ to grant access")
            IXFoot(gap: 12) {
                IXButton("Skip", .link, id: "safari-skip") { Task { await model.keychainDecline() } }
                Spacer()
                IXButton("Select different browser", .secondary, small: true, id: "safari-other") { model.state.browserFrom = "safari"; model.state.browserChoice = model.browsers?["chosenId"]?.string; model.state.dialog = "keychain-browser" }
                IXButton(waiting ? "Waiting for access…" : "Grant disk access", small: true, disabled: model.busy == "keychain", id: "safari-grant") { Task { await model.grantDisk() } }
            }
        case "browser-profile":
            let asking = model.busy == "keychain"
            IXTitle("Select your \(ImportFlowModel.browserName(model.browsers?["chosenId"]?.string).replacingOccurrences(of: #"^(Google|Microsoft)\s+"#, with: "", options: .regularExpression)) profile")
            VStack(spacing: 7) {
                ForEach(OnboardingHelpers.profilesOf(model.browsers), id: \.self) { profile in
                    let id = J.str(profile["id"])
                    choiceRow(on: F.profileChoice == id, id: "browser-profile=\(id)", action: { model.state.profileChoice = id }) {
                        Text(J.str(profile["name"]).isEmpty ? id : J.str(profile["name"])).font(IX.font(15, 400)).frame(maxWidth: .infinity, alignment: .leading)
                        if !J.str(profile["email"]).isEmpty { Text(J.str(profile["email"])).font(IX.font(13, 400)).foregroundStyle(IX.mute).lineLimit(1) }
                    }
                }
            }.padding(.top, 16)
            IXFoot { IXButton(asking ? "Waiting for macOS…" : "Continue", small: true, disabled: F.profileChoice == nil || asking, id: "browser-profile-continue") { Task { await model.chooseProfile() } } }
        case "notes-permission":
            IXTitle("Allow Engelbart to read Apple Notes?")
            IXFoot {
                IXButton("Don’t allow", .link) { Task { await model.notesAnswer(false) } }
                IXButton("Allow", id: "notes-allow") { Task { await model.notesAnswer(true) } }
            }
        case "keychain-browser":
            IXTitle("Which browser should Engelbart use?")
            VStack(spacing: 7) {
                ForEach(J.arr(model.browsers?["browsers"]), id: \.self) { browser in
                    let id = J.str(browser["id"])
                    choiceRow(on: F.browserChoice == id, id: "keychain-browser=\(id)", action: { model.state.browserChoice = id }) {
                        LogoImage(file: Logos.browserIds.contains(id) ? "browsers/\(id)" : nil, size: 24)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(J.str(browser["name"])).font(IX.font(15, 400))
                            if J.truthy(browser["isDefault"]) { Text("Default").font(IX.font(11.5, 400)).foregroundStyle(IX.mute) }
                        }
                        Spacer()
                        if F.browserChoice == id { Glyph(IXGlyph.check, size: 15).foregroundStyle(IX.blue) }
                    }
                }
            }.padding(.top, 16)
            IXFoot {
                IXButton("Back", .link) { model.state.dialog = F.browserFrom == "safari" ? "safari" : "keychain" }
                IXButton("Use \(ImportFlowModel.browserName(F.browserChoice))", disabled: F.browserChoice == nil, id: "use-browser") { Task { await model.useBrowser() } }
            }
        case "organize": organizeDialog
        case "browser-agents":
            IXTitle("Let agents use \(model.browserNow)?")
            IXPara("They’ll read your selected sources in the background.")
            IXFoot {
                IXButton("Don’t allow", .link) { Task { await model.browserAgentsAnswer("declined") } }
                IXButton("Allow", small: true, id: "import-browser-agents-allow") { Task { await model.browserAgentsAnswer("allowed") } }
            }
        case "browser-agents-confirm":
            let browser = F.agentsBrowser ?? "your browser"
            IXTitle("Are you sure?")
            IXPara("Without \(browser), agents bring in your web apps through Engelbart’s own browser instead, with the sign-ins it copied or those you make inside Engelbart.")
            IXFoot {
                IXButton("Continue without it", .link) { Task { await model.browserAgentsAnswer("declined") } }
                IXButton("Allow \(browser)", small: true) { Task { await model.browserAgentsAnswer("allowed") } }
            }
        case "starting":
            IXTitle("Starting your imports")
            IXPara("Each agent will bring in only what pertains to \(model.chosen.map(\.title).joined(separator: " and ").isEmpty ? "your projects" : model.chosen.map(\.title).joined(separator: " and ")).")
            HStack(spacing: 8) { Circle().fill(IX.grey).frame(width: 6, height: 6); Text(model.mode == .modal ? "Starting…" : "Setting up your projects…").font(IX.font(12.5, 400)).foregroundStyle(IX.mute) }.padding(.top, 22)
        case "first-project":
            let pick = F.firstChoice ?? F.picked.first
            IXTitle("Which project do you want to start with?")
            VStack(spacing: 7) {
                ForEach(model.chosen, id: \.id) { project in
                    choiceRow(on: pick == project.id, id: "first-project=\(project.id)", action: { model.state.firstChoice = project.id }) {
                        Text(project.title).font(IX.font(14.5, 400)).frame(maxWidth: .infinity, alignment: .leading)
                        if pick == project.id { Glyph(IXGlyph.check, size: 15).foregroundStyle(IX.blue) }
                    }
                }
            }.padding(.top, 16)
            IXFoot {
                IXButton("Back", .link) { model.state.dialog = nil }
                IXButton("Continue", small: true, disabled: pick == nil, id: "first-project-open") { Task { await model.firstProjectContinue() } }
            }
        case "obsidian-picker":
            let id = F.pickerFor ?? "Obsidian"
            ObsidianPickerView(model: ObsidianPickerModel(api: model.api, chosen: model.scopeOf(id).folders.map(\.path)),
                               onChoose: { picks in model.addFolders(id, picks); model.state.dialog = nil }, onCancel: { model.state.dialog = nil })
        case "work-add-project":
            IXTitle("Add a project")
            label("Project title")
            IXField("Memex", text: $model.draft.title, id: "custom-project-title") { model.addProject() }.padding(.top, 7)
            HStack(spacing: 4) { label("Description"); Text("(optional)").font(IX.font(13, 400)).foregroundStyle(IX.mute).padding(.top, 20) }
            GrowingField("Understanding the history of the Memex", text: $model.draft.description, id: "custom-project-description").padding(.top, 7)
            IXFoot {
                IXButton("Cancel", .link) { model.state.dialog = nil }
                IXButton("Add project", disabled: model.draft.title.trimmingCharacters(in: .whitespaces).isEmpty, id: "add-project-save") { model.addProject() }
            }
        case "work-add-tool":
            IXTitle("Add a tool")
            IXField("Search supported tools…", text: $model.catalogQuery, id: "catalog-search").padding(.top, 7)
            ScrollView {
                FlowRow(spacing: 7) {
                    ForEach(model.catalogMatches, id: \.id) { tool in
                        Button(action: { model.pickTool(tool.id) }) {
                            HStack(spacing: 7) { ToolLogo(id: tool.id, size: 14); Text(tool.name).font(IX.font(12, 400)).foregroundStyle(IX.ink) }
                                .padding(.horizontal, 9).padding(.vertical, 7).overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(IX.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain).driveID("catalog-tool=\(tool.id)")
                    }
                }
            }
            .frame(maxHeight: 180).padding(.top, 16)
            label("Or add another tool")
            IXField("Tool name", text: $model.draft.tool, id: "custom-tool-name").padding(.top, 7)
            IXField("Website (optional)", text: $model.draft.website, id: "custom-tool-website").padding(.top, 7)
            IXFoot {
                IXButton("Cancel", .link) { model.state.dialog = nil }
                IXButton("Add tool", disabled: model.draft.tool.trimmingCharacters(in: .whitespaces).isEmpty, id: "add-tool-save") { model.addTool() }
            }
        default:
            EmptyView()
        }
    }

    func label(_ text: String) -> some View { Text(text).font(IX.font(13, 400)).foregroundStyle(IX.body).padding(.top, 20) }

    /// A row of a dialog's list (.prof): 54 tall, radius 10, black 1.5 when chosen.
    func choiceRow<Content: View>(on: Bool, id: String, action: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
        Button(action: action) {
            HStack(spacing: 12) { content() }
                .foregroundStyle(IX.ink)
                .padding(.horizontal, 14).padding(.vertical, 9).frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(on ? IX.wash : Color.white))
                .chosen(on)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).driveID(id)
    }

    /// How should Engelbart import your sources? (S8): the agents' icon and a hand; "(recommended)" only while the first
    /// title fits on one line at the dialog's width.
    var methodDialog: some View {
        VStack(alignment: .leading, spacing: 0) {
            IXTitle("How should Engelbart import your sources?")
            VStack(spacing: 7) {
                methodRow(icon: IXGlyph.agent, title: "Import in the background with agents", recommended: true,
                          line: "Engelbart will dispatch local background agents to bring in your approved sources with minimal intervention.", id: "import-method=agents") { model.inBackground() }
                methodRow(icon: IXGlyph.hand, title: "Import manually with fine-grained permissions", recommended: false,
                          line: "Engelbart will ask for your input before importing anything and will use permission prompts to ask for explicit permission before accessing anything.", id: "import-method=manual") { Task { await model.manually() } }
            }
            .padding(.top, 16)
            HStack { IXButton("Back", .link, id: "import-method-back") { Task { await model.methodBack() } }; Spacer() }.padding(.top, 22)
        }
    }

    func methodRow(icon: String, title: String, recommended: Bool, line: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 14) {
                Glyph(icon, size: 21).foregroundStyle(IX.ink).frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 4) {
                    ViewThatFits(in: .horizontal) {
                        if recommended { Text("\(title) (recommended)").lineLimit(1).fixedSize() }
                        Text(title)
                    }
                    .font(IX.font(15, 500)).foregroundStyle(IX.ink)
                    Text(line).font(IX.font(13, 400)).foregroundStyle(IX.mute).lineSpacing(13 * 0.5 - 3).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(17)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).driveID(id)
    }

    /// Allow Engelbart to organize your research (2026-10-15, Granola's card in Engelbart's look, no lines between rows).
    var organizeDialog: some View {
        let done = F.folderAnswers != nil
        return VStack(alignment: .leading, spacing: 0) {
            IXTitle("Allow Engelbart to organize your research")
            VStack(spacing: 2) {
                HStack {
                    Text("View my files locally").font(IX.font(14.5, 400)).foregroundStyle(IX.ink)
                    Spacer()
                    if done { enabled.driveID("organize-enabled=files") } else {
                        Button(action: { Task { await model.connectDesktop() } }) {
                            HStack(spacing: 8) { Glyph(IXGlyph.folder, size: 15, width: 1.7); Text(model.busy == "folders" ? "Connecting…" : "Connect desktop") }
                                .font(IX.font(14, 500)).foregroundStyle(IX.ink).padding(.horizontal, 20).frame(minHeight: 38)
                                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(IX.line2, lineWidth: 1))
                        }
                        .buttonStyle(.plain).disabled(model.busy == "folders").opacity(model.busy == "folders" ? 0.4 : 1).driveID("organize-connect")
                    }
                }
                .frame(minHeight: 52).padding(.horizontal, 16)
                HStack { Text("Analyze using agents").font(IX.font(14.5, 400)).foregroundStyle(IX.ink); Spacer(); enabled.driveID("organize-enabled=agents") }
                    .frame(minHeight: 52).padding(.horizontal, 16)
            }
            .padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(IX.line, lineWidth: 1))
            .padding(.top, 18).padding(.bottom, 4)
            IXFoot {
                IXButton("Skip", .link, id: "organize-skip") { Task { await model.organizeSkip() } }
                Spacer()
                IXButton("Continue", small: true, disabled: !done, id: "organize-continue") { Task { await model.organizeContinue() } }
            }
        }
    }

    var enabled: some View {
        HStack(spacing: 6) { Glyph(IXGlyph.check, size: 14, width: 2.2); Text("Enabled") }
            .font(IX.font(13.5, 500)).foregroundStyle(IX.ink).padding(.horizontal, 14).frame(minHeight: 34)
            .background(Capsule().fill(hex("#f2f2f2")))
    }

    /// The error line (bottom-left card, red, × dismisses).
    var errorLine: some View {
        VStack {
            Spacer()
            HStack {
                HStack(spacing: 10) {
                    Text(model.error).font(IX.font(12.5, 400)).foregroundStyle(hex("#e70022"))
                    Button(action: { model.error = "" }) { Text("×").font(IX.font(14, 400)).foregroundStyle(IX.line2) }.buttonStyle(.plain)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(IX.line, lineWidth: 1))
                .frame(maxWidth: 560, alignment: .leading)
                Spacer()
            }
            .padding(.leading, 24).padding(.bottom, 96)
        }
        .driveID("import-error")
    }
}

/// A source's logo (ImportFlow.jsx ToolLogo): the catalog's; a notes app's saved websites, its logo with a globe in the
/// corner; PDFs and folders the folder; the browser history the web glyph; a tool the agents found none, and no room.
struct ToolLogo: View {
    let id: String
    var size: CGFloat = 17
    var body: some View {
        if ImportFlowState.isLinks(id) {
            ZStack(alignment: .bottomTrailing) {
                LogoImage(file: Logos.toolFile(ImportFlowState.linkedApp(id)), size: size)
                Glyph(IXGlyph.globe, size: 11, width: 1.9).foregroundStyle(IX.body).background(Circle().fill(Color.white).frame(width: 14, height: 14)).offset(x: 5, y: 4)
            }
            .frame(width: size, height: size)
        } else if let file = Logos.toolFile(id) {
            LogoImage(file: file, size: size)
        } else if id == ConnectSources.localPDFs || id == ImportFlow.localFolders {
            Glyph(IXGlyph.folder, size: size)
        } else if id == ImportFlow.sites {
            Glyph(IXGlyph.web, size: size)
        }
    }
}

/// Chips that wrap (the project chips, people, chosen files, the catalog's tools).
struct FlowRow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { y += line + spacing; x = 0; line = 0 }
            x += size.width + spacing; line = max(line, size.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { y += line + spacing; x = bounds.minX; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; line = max(line, size.height)
        }
    }
}
