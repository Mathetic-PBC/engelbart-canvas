import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// src/renderer/screens/AgentMap.jsx: the Agent Viewer (2026-10-12; first design again 2026-10-13). Runs: every run newest
// first, live (`engelbart:agent-run`), filtered by Project, Workspace and Date; the one selected in sections (System prompt,
// Context, Steps, Written), all closed at first, the one opened kept from run to run; a routed question shows "1.
// Classification" (closed) and "2. Agent: …" (open). Design: one agent at a time. Benchmark: ./BenchmarkView.swift.
// Plain and dense on purpose: one monospace font 12/1.45, #111 on white, thin #ddd rules. Keys (no legend): j/k the next
// and previous run, 1–4 a section (the Agent part opened first), c copies the open section, e exports the run, E every run.
// The Viewer's own colours are the CSS's hex values (AgentMap.jsx S); EngelbartUI's tokens have no equivalents.

enum AM {
    static let font = Font(NSFont.monospacedSystemFont(ofSize: 12, weight: .regular))
    static let bold = Font(NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold))
    static let ink = Color(NSColor(hex: "#111111"))
    static let dim = Color(NSColor(hex: "#777777"))
    static let rule = Color(NSColor(hex: "#dddddd"))
    static let rowRule = Color(NSColor(hex: "#eeeeee"))
    static let selected = Color(NSColor(hex: "#eef3ff"))
    static let preBg = Color(NSColor(hex: "#f6f6f6"))
    static let preBorder = Color(NSColor(hex: "#e6e6e6"))
    static let error = Color(NSColor(hex: "#aa0000"))
    static let errorBorder = Color(NSColor(hex: "#e6b8b8"))
    static let escalated = Color(NSColor(hex: "#9a6700"))
}

public let agentMapSections: [(id: String, title: String)] = [("system", "System prompt"), ("context", "Context"), ("steps", "Steps"), ("written", "Written")]

@MainActor
public final class AgentMapModel: ObservableObject {
    @Published public var tab = "runs"
    @Published public private(set) var runs: [JSONValue] = []
    @Published public var selected: String?
    @Published public private(set) var record: JSONValue?
    @Published public var open: String?
    @Published public var routeOpen: String?
    /// Which of the panel's two parts are open (2026-10-13): Classification closed, the Agent open.
    @Published public var parts = (route: false, agent: true)
    @Published public private(set) var route: (id: String, record: JSONValue?)?
    @Published public var filter = RunFilter.all { didSet { follow() } }
    @Published public private(set) var design: JSONValue?
    @Published public var note = ""
    @Published public var designAgent: String?

    let channels: AgentMapChannels
    let copyText: (String) -> Void
    private var token: EventHub.Token?
    private var refetch: DispatchWorkItem?
    private var routeRefetch: DispatchWorkItem?
    private let hub: EventHub

    public init(channels: AgentMapChannels, copyText: @escaping (String) -> Void = { NSPasteboard.general.clearContents(); NSPasteboard.general.setString($0, forType: .string) }, hub: EventHub = .shared) {
        self.channels = channels
        self.copyText = copyText
        self.hub = hub
        runs = channels.runs()
        token = hub.on("engelbart:agent-run") { [weak self] summary in MainActor.assumeIsolated { self?.changed(summary) } }
        follow()
    }

    deinit { if let token { hub.off(token) } }

    /// The rows the list shows, newest first, the filters applied.
    public var shown: [JSONValue] { RunText.filterRuns(RunText.listedRuns(runs), filter, names: RunText.projectNames(runs)) }

    /// A run changed: put first; the run in view and its router record read again at most every 400 ms.
    func changed(_ summary: JSONValue) {
        guard let id = summary["id"]?.string else { return }
        runs = [summary] + runs.filter { $0["id"]?.string != id }
        if id == selected && refetch == nil {
            let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated {
                guard let self else { return }
                self.refetch = nil
                if let full = self.channels.run(id), id == self.selected { self.record = full }
            } }
            refetch = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
        }
        if id == route?.id && routeRefetch == nil {
            let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated {
                guard let self else { return }
                self.routeRefetch = nil
                if let full = self.channels.run(id), id == self.route?.id { self.route = (id, full) }
            } }
            routeRefetch = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
        }
        follow()
    }

    /// When the selected run is not among the rows shown, the first is selected, or none.
    func follow() {
        let rows = shown
        if !rows.contains(where: { $0["id"]?.string == selected }) { select(rows.first?["id"]?.string) }
    }

    public func select(_ id: String?) {
        guard id != selected || record == nil else { return }
        selected = id
        record = id.flatMap { channels.run($0) }
        let router = RunText.routerFor(runs.first { $0["id"]?.string == id }, runs)
        if let rid = router?["id"]?.string { route = (rid, channels.run(rid)) } else { route = nil }
    }

    /// The router part only for the run it belongs to, and left out when its record cannot be found.
    public var panelRoute: JSONValue? { route?.record }

    public func toggle(_ id: String) {
        if id.hasPrefix("route:") { routeOpen = routeOpen == id ? nil : id } else { open = open == id ? nil : id }
    }

    public func togglePart(_ name: String) { if name == "route" { parts.route.toggle() } else { parts.agent.toggle() } }

    public func showDesign() { tab = "design"; design = channels.agentDesign() }

    public func exportRuns(all: Bool) {
        Task { @MainActor in
            let records = all ? runs.compactMap { channels.run($0["id"]?.string ?? "") } : (record.map { [$0] } ?? [])
            guard let first = records.first else { note = "Nothing to export."; return }
            let name = all ? "agent-runs-\(String(Time.iso().prefix(10)))" : "agent-run-\(first["agent"]?.stringish ?? "")-\(String((first["id"]?.stringish ?? "").prefix(8)))"
            let title = all ? "Agent runs" : "\(RunText.runLabel(first)): \(RunText.firstWords(first["question"]?.stringish, 12))"
            do {
                let saved = try await channels.export(RunText.exportPage(records, title: title), name: name)
                note = saved.map { "Saved \($0)" } ?? "Not saved."
            } catch { note = error.localizedDescription }
        }
    }

    /// A key of the window (j, k, 1–4, c, e, E) → whether it was used.
    public func key(_ chars: String) -> Bool {
        let rows = shown
        let at = rows.firstIndex { $0["id"]?.string == selected } ?? -1
        switch chars {
        case "j": if !rows.isEmpty { select(rows[min(rows.count - 1, at + 1)]["id"]?.string) }
        case "k": if !rows.isEmpty { select(rows[max(0, at - 1)]["id"]?.string) }
        case "1", "2", "3", "4":
            tab = "runs"
            parts.agent = true
            open = agentMapSections[Int(chars)! - 1].id
        case "c":
            guard let record, let open else { return false }
            let text = RunText.sectionText(record, open)
            copyText(jsSlice(text, 400_000))
            note = "Copied \(agentMapSections.first { $0.id == open }!.title)\(jsLength(text) > 400_000 ? " (first 400,000 characters)" : "")."
        case "e": exportRuns(all: false)
        case "E": exportRuns(all: true)
        default: return false
        }
        return true
    }
}

public struct AgentMapView: View {
    @ObservedObject var model: AgentMapModel
    let benchmark: () -> AnyView
    @State private var monitor: Any?

    /// `benchmark()`: the Benchmark tab (BenchmarkView over a BenchmarkModel), nil-safe for a copy without one.
    public init(model: AgentMapModel, benchmark: (() -> AnyView)? = nil) {
        self.model = model
        self.benchmark = benchmark ?? { AnyView(Text("The benchmark is not available.").font(AM.font).foregroundStyle(AM.dim).padding(14)) }
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                tabButton("runs", "Runs") { model.tab = "runs" }
                tabButton("design", "Design") { model.showDesign() }
                tabButton("benchmark", "Benchmark") { model.tab = "benchmark" }
                Spacer()
                Text(model.note).foregroundStyle(AM.dim).lineLimit(1)
                plainButton("Export run") { model.exportRuns(all: false) }.disabled(model.record == nil)
                plainButton("Export all") { model.exportRuns(all: true) }.disabled(model.runs.isEmpty)
            }
            .padding(.vertical, 6).padding(.horizontal, 10)
            .overlay(alignment: .bottom) { AM.rule.frame(height: 1) }
            switch model.tab {
            case "runs":
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        RunFiltersView(model: model)
                        ScrollView { RunListView(model: model) }
                    }
                    .frame(width: 360)
                    .overlay(alignment: .trailing) { AM.rule.frame(width: 1) }
                    ScrollView {
                        Group {
                            if let record = model.record {
                                RunPanelView(model: model, record: record)
                            } else {
                                Text(model.shown.isEmpty ? "" : "Loading…").foregroundStyle(AM.dim)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(EdgeInsets(top: 8, leading: 14, bottom: 40, trailing: 14))
                    }
                }
            case "design":
                ScrollView { DesignView(design: model.design, picked: $model.designAgent).frame(maxWidth: .infinity, alignment: .leading).padding(EdgeInsets(top: 8, leading: 14, bottom: 40, trailing: 14)) }
            default:
                benchmark()
            }
        }
        .font(AM.font).foregroundStyle(AM.ink).background(Color.white)
        .onAppear {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                guard event.window?.title == AgentMapWindow.title, event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
                      !(event.window?.firstResponder is NSTextView), let chars = event.characters else { return event }
                return model.key(chars) ? nil : event
            }
        }
        .onDisappear { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    }

    private func tabButton(_ id: String, _ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(model.tab == id ? AM.bold : AM.font).padding(.vertical, 2)
                .overlay(alignment: .bottom) { (model.tab == id ? AM.ink : Color.clear).frame(height: 2) }
        }
        .buttonStyle(.plain)
    }
}

func plainButton(_ title: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) { Text(title).padding(.vertical, 1).padding(.horizontal, 6).overlay(Rectangle().stroke(AM.rule, lineWidth: 1)) }.buttonStyle(.plain)
}

/// One row of three selects over the list: Project, Workspace (the Project's), Date. Changing Project resets Workspace.
struct RunFiltersView: View {
    @ObservedObject var model: AgentMapModel
    var body: some View {
        let options = RunText.filterOptions(RunText.listedRuns(model.runs), model.filter, names: RunText.projectNames(model.runs))
        HStack(spacing: 6) {
            select(model.filter.project.isEmpty ? "All projects" : model.filter.project, [("", "All projects")] + options.projects.map { ($0, $0) }) { model.filter = RunFilter(project: $0, workspace: "", day: model.filter.day) }
                .help("Project")
            select(model.filter.workspace.isEmpty ? "All workspaces" : model.filter.workspace, [("", "All workspaces")] + options.workspaces.map { ($0, $0) }) { model.filter.workspace = $0 }
                .help("Workspace")
            select(options.days.first { $0.key == model.filter.day }?.label ?? "All dates", [("", "All dates")] + options.days.map { ($0.key, $0.label) }) { model.filter.day = $0 }
                .help("Date")
        }
        .padding(.vertical, 5).padding(.horizontal, 10)
        .overlay(alignment: .bottom) { AM.rule.frame(height: 1) }
    }

    private func select(_ shown: String, _ options: [(String, String)], _ pick: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(options, id: \.0) { option in Button(option.1) { pick(option.0) } }
        } label: {
            Text(shown).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 1).padding(.horizontal, 2)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .overlay(Rectangle().stroke(AM.rule, lineWidth: 1))
        .frame(maxWidth: .infinity)
    }
}

/// The list: each row the person's words, then one dim line (agent, time, first message or reply, how it ended); the
/// hover gives the place, the Build id and the whole text. One row per question.
struct RunListView: View {
    @ObservedObject var model: AgentMapModel
    var body: some View {
        let names = RunText.projectNames(model.runs)
        let listed = RunText.listedRuns(model.runs)
        let shown = RunText.filterRuns(listed, model.filter, names: names)
        VStack(alignment: .leading, spacing: 0) {
            if listed.isEmpty {
                Text("No runs yet. Ask @bart, @chat, @brainstorm, @discover or @create, or start a Build, in any window.").foregroundStyle(AM.dim).padding(10)
            } else if shown.isEmpty {
                Text("No runs match.").foregroundStyle(AM.dim).padding(10)
            } else {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, run in
                    let id = run["id"]?.string
                    let hover = [RunText.placeLabel(run, names), run["buildId"]?.string.map { "Build \($0)" } ?? "", RunText.rowText(run)].filter { !$0.isEmpty }.joined(separator: "\n")
                    VStack(alignment: .leading, spacing: 0) {
                        Text(RunText.rowText(run)).lineLimit(1).truncationMode(.tail)
                        Text(RunText.rowLine(run)).foregroundStyle(AM.dim).lineLimit(1).truncationMode(.tail)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 5).padding(.horizontal, 10)
                    .background(id == model.selected ? AM.selected : Color.clear)
                    .overlay(alignment: .bottom) { AM.rowRule.frame(height: 1) }
                    .contentShape(Rectangle())
                    .onTapGesture { model.select(id) }
                    .help(hover)
                }
            }
        }
    }
}

/// Text shown only once it is opened (a block of documents can be large).
struct ExpandView: View {
    let label: AnyView
    let text: String
    var initiallyOpen = false
    var flat = false
    @State private var open: Bool?
    var body: some View {
        let isOpen = open ?? initiallyOpen
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) { Text(isOpen ? "▾" : "▸"); label }.contentShape(Rectangle()).onTapGesture { open = !isOpen }
            if isOpen { PreText(text.isEmpty ? "(empty)" : text) }
        }
        .padding(.leading, flat ? 0 : 14).padding(.vertical, flat ? 0 : 2)
        .onChange(of: initiallyOpen) { _, now in if now { open = true } }
    }
}

struct PreText: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(6)
            .background(AM.preBg).overlay(Rectangle().stroke(AM.preBorder, lineWidth: 1)).padding(.vertical, 3)
    }
}

/// The right-hand panel: with a router's record, "1. Classification" and "2. Agent: …", each opening and closing; else
/// the run's sections alone.
struct RunPanelView: View {
    @ObservedObject var model: AgentMapModel
    let record: JSONValue
    var body: some View {
        if let route = model.panelRoute, model.route?.id != nil {
            VStack(alignment: .leading, spacing: 0) {
                partHead("route", model.parts.route, "1. Classification", RunText.classificationLine(route, record), first: true)
                if model.parts.route { RunDetailView(model: model, record: route, prefix: "route:") }
                partHead("agent", model.parts.agent, "2. Agent: \(RunText.agentWords(record))", "", first: false)
                if model.parts.agent { RunDetailView(model: model, record: record, prefix: "") }
            }
        } else if model.route != nil && model.route?.record == nil && model.parts.route {
            Text("Loading…").foregroundStyle(AM.dim)
        } else {
            RunDetailView(model: model, record: record, prefix: "")
        }
    }

    private func partHead(_ name: String, _ open: Bool, _ title: String, _ line: String, first: Bool) -> some View {
        (Text(open ? "▾ " : "▸ ") + Text(title).font(AM.bold) + Text(line.isEmpty ? "" : " · \(line)").foregroundColor(AM.dim))
            .padding(.top, first ? 4 : 14).padding(.bottom, 2)
            .contentShape(Rectangle()).onTapGesture { model.togglePart(name) }
    }
}

/// A run's four sections; `prefix` (the router's part: 'route:') goes before each section's id.
struct RunDetailView: View {
    @ObservedObject var model: AgentMapModel
    let record: JSONValue
    let prefix: String

    var body: some View {
        let openId = prefix.isEmpty ? model.open : model.routeOpen
        VStack(alignment: .leading, spacing: 0) {
            if let error = record["error"]?.string, !error.isEmpty {
                Text("\(record["status"]?.stringish ?? ""): \(error)").foregroundStyle(AM.error).padding(4).overlay(Rectangle().stroke(AM.errorBorder, lineWidth: 1)).padding(.vertical, 6)
            }
            section(1, "system", "System prompt", openId) { PreText(record["system"]?.stringish ?? "") }
            section(2, "context", "Context", openId) {
                ForEach(Array(RunText.contextBlocks(record).enumerated()), id: \.offset) { _, block in
                    ExpandView(label: AnyView(Text(block.label) + Text(" \(block.text.isEmpty ? "none" : RunText.sizeLabel(block.text))").foregroundColor(AM.dim)), text: block.text)
                }
            }
            section(3, "steps", "Steps", openId) {
                let steps = record["steps"]?.array ?? []
                if steps.isEmpty { Text("no model run").foregroundStyle(AM.dim).padding(.leading, 14) }
                ForEach(Array(steps.enumerated()), id: \.offset) { n, step in StepView(step: step, n: n + 1) }
            }
            section(4, "written", "Written", openId) {
                let written = RunText.writtenText(record)
                PreText(written.isEmpty ? "(nothing)" : written)
                if record["agent"]?.string == "create" {
                    Text("kept in the library").foregroundStyle(AM.dim).padding(.leading, 14)
                    PreText(RunText.createdLines(record))
                }
            }
        }
    }

    @ViewBuilder private func section<C: View>(_ n: Int, _ id: String, _ title: String, _ openId: String?, @ViewBuilder content: () -> C) -> some View {
        let full = "\(prefix)\(id)"
        VStack(alignment: .leading, spacing: 0) {
            (Text(openId == full ? "▾ " : "▸ ") + Text("\(n) \(title)").font(AM.bold))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3)
                .overlay(alignment: .top) { AM.rule.frame(height: 1) }
                .padding(.top, 6)
                .contentShape(Rectangle()).onTapGesture { model.toggle(full) }
            if openId == full { content() }
        }
    }
}

struct StepView: View {
    let step: JSONValue
    let n: Int
    var body: some View {
        let output = step["output"]
        let running = output == nil || output!.isNull
        let tools = step["tools"]?.array ?? []
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text("step \(n)").font(AM.bold)
                Text(" \(step["name"]?.string ?? step["model"]?.stringish ?? "") ")
                Text("(\(step["model"]?.stringish ?? "")) · \(step["effort"]?.stringish ?? "")\(step["ms"]?.double.map { " · \(RunText.msLabel($0))" } ?? (running ? " · running" : ""))").foregroundStyle(AM.dim)
                if step["escalated"]?.truthy ?? false { Text(" · escalated").font(AM.bold).foregroundStyle(AM.escalated) }
            }
            ExpandView(label: AnyView(Text("input ") + Text(RunText.sizeLabel(step["input"]?.stringish)).foregroundColor(AM.dim)), text: step["input"]?.stringish ?? "")
            Text("tool calls (\(tools.count)\((step["toolsDropped"]?.truthy ?? false) ? ", and \(grouped(step["toolsDropped"]?.int ?? 0)) more not kept" : ""))").foregroundStyle(AM.dim).padding(.leading, 14)
            ForEach(Array(tools.enumerated()), id: \.offset) { _, tool in ToolCallView(tool: tool, from: step["at"]?.double ?? 0) }
            ExpandView(label: AnyView(Text("output ") + Text(running ? "running" : RunText.sizeLabel(output?.stringish)).foregroundColor(AM.dim)), text: running ? "" : (output?.stringish ?? ""), initiallyOpen: !running)
        }
        .padding(EdgeInsets(top: 6, leading: 14, bottom: 10, trailing: 0))
    }
}

struct ToolCallView: View {
    let tool: JSONValue
    let from: Double
    @State private var open = false
    var body: some View {
        let result = tool["result"].flatMap { $0.isNull ? JSONValue?.none : $0 }
        let at = tool["at"]?.double ?? from
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text(open ? "▾ " : "▸ ")
                Text(tool["name"]?.stringish ?? "").font(AM.bold)
                Text(" +\(RunText.msLabel(max(0, at - from)))\(tool["ms"]?.double.map { " · took \(RunText.msLabel($0))" } ?? " · running")\(result.map { " · \(grouped($0["size"]?.int ?? 0)) chars" } ?? "")\(result?["exitCode"].flatMap { $0.isNull ? nil : " · exit \($0.stringish)" } ?? "")").foregroundStyle(AM.dim)
                if result?["error"]?.truthy ?? false { Text(" · error").foregroundStyle(AM.error) }
                if !open { Text(" \(RunText.firstWords(re("\\s+").replace(RunText.json(tool["input"]), with: " "), 14))").foregroundStyle(AM.dim).lineLimit(1) }
            }
            .contentShape(Rectangle()).onTapGesture { open.toggle() }
            if open {
                Text("arguments").foregroundStyle(AM.dim)
                PreText(RunText.json(tool["input"]).isEmpty ? "(none)" : RunText.json(tool["input"]))
                if let result {
                    Text("result, first 2,000 characters").foregroundStyle(AM.dim)
                    PreText(result["excerpt"]?.stringish.nilIfEmpty ?? "(empty)")
                }
            }
        }
        .padding(.leading, 8).overlay(alignment: .leading) { Color(NSColor(hex: "#cccccc")).frame(width: 1) }
        .padding(.leading, 14).padding(.vertical, 2)
    }
}

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

/// One agent at a time: a row of tabs in design.agents' order, and the picked one's block (the first if none or unknown).
struct DesignView: View {
    let design: JSONValue?
    @Binding var picked: String?

    var body: some View {
        if let agents = design?["agents"]?.array {
            if let agent = agents.first(where: { $0["agent"]?.string == picked }) ?? agents.first {
                let info = RunText.agentInfo(agent["agent"]?.string)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 12) {
                        ForEach(Array(agents.enumerated()), id: \.offset) { _, held in
                            let on = held["agent"] == agent["agent"]
                            Button { picked = held["agent"]?.string } label: {
                                Text(RunText.agentInfo(held["agent"]?.string).name).font(on ? AM.bold : AM.font).padding(.vertical, 2)
                                    .overlay(alignment: .bottom) { (on ? AM.ink : Color.clear).frame(height: 2) }
                            }.buttonStyle(.plain)
                        }
                    }
                    .padding(.bottom, 4)
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 0) {
                            Text(info.name).font(AM.bold)
                            if !info.token.isEmpty {
                                Text(" · \(info.token)\(agent["token"]?.string != nil && agent["agent"]?.string != agent["token"]?.string ? " · internally '\(agent["agent"]!.stringish)'" : "")").foregroundStyle(AM.dim)
                            }
                            if info.inside != nil { Text(" · shown inside a Build's output").foregroundStyle(AM.dim) }
                        }
                        AM.rule.frame(height: 1).padding(.top, 6).padding(.bottom, 2)
                        if agent["planned"]?.truthy ?? false { Text("Planned, not built yet").foregroundStyle(AM.dim).padding(.leading, 14) } else { DesignBody(agent: agent) }
                        if let calls = agent["calls"]?.array, !calls.isEmpty {
                            group("Hands work to") {
                                ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                                    (Text(RunText.agentInfo(call["to"]?.string).name).font(AM.bold) + Text(" \(call["how"]?.stringish ?? "")").foregroundColor(AM.dim)).padding(.leading, 14).padding(.vertical, 2)
                                }
                            }
                        }
                        if let started = agent["startedFrom"]?.array {
                            group("Started from") { ForEach(Array(started.enumerated()), id: \.offset) { _, s in Text(s.stringish).padding(.leading, 14).padding(.vertical, 2) } }
                        }
                    }
                    .padding(.top, 6).padding(.bottom, 10)
                    .overlay(alignment: .top) { AM.rule.frame(height: 1) }
                }
            } else {
                Text("No agents.").foregroundStyle(AM.dim)
            }
        } else {
            Text("Loading…").foregroundStyle(AM.dim)
        }
    }
}

func group<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 0) { Text(title).font(AM.bold).padding(.top, 10).padding(.bottom, 3); content() }
}

/// One item: a dim label 160 wide, the value wrapping in its own column.
func designRow<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
    HStack(alignment: .top, spacing: 10) {
        Text(label).foregroundStyle(AM.dim).frame(width: 160, alignment: .leading)
        VStack(alignment: .leading, spacing: 0) { content() }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.leading, 14).padding(.vertical, 2)
}

struct DesignBody: View {
    let agent: JSONValue
    static let modes = ["quick", "standard", "deep"]

    var body: some View {
        let context = agent["context"] ?? .object([:])
        let timeout = agent["timeout"]?.object ?? [:]
        let isBuild = agent["agent"]?.string == "build"
        VStack(alignment: .leading, spacing: 0) {
            if let rules = agent["rules"]?.array {
                group("How it routes") {
                    ForEach(Array(rules.enumerated()), id: \.offset) { i, rule in
                        (Text("\(i + 1). \(rule["when"]?.stringish ?? "") ") + Text("→ \(rule["to"]?.stringish ?? "")").font(AM.bold)).padding(.leading, 36).padding(.vertical, 1)
                    }
                }
            }
            group("What it sees") {
                if let inputs = agent["inputs"]?.array { designRow("Inputs") { ForEach(Array(inputs.enumerated()), id: \.offset) { Text($1.stringish) } } }
                designRow("New session") {
                    ForEach(Array((context["blocks"]?.array ?? []).enumerated()), id: \.offset) { _, b in
                        Text(b["block"]?.stringish ?? ""); Text(b["note"]?.stringish ?? "").foregroundStyle(AM.dim)
                    }
                }
                if let resumed = context["resumed"]?.array, !resumed.isEmpty {
                    designRow(isBuild ? "A later turn" : "Resumed") { ForEach(Array(resumed.enumerated()), id: \.offset) { Text($1.stringish) } }
                }
                designRow("Folders") { Text(context["dirs"]?.stringish ?? "") }
            }
            group("Prompt") {
                let prompt = agent["prompt"] ?? .object([:])
                let note = prompt["note"]?.string
                if let note { Text(note).foregroundStyle(AM.dim).padding(.leading, 14) }
                let source = note != nil ? "per Build" : (prompt["custom"]?.truthy ?? false) ? "custom (\(prompt["file"]?.stringish ?? ""))" : "built-in"
                ExpandView(label: AnyView(Text(note != nil ? "prompt template " : "system prompt ") + Text("\(source) · \(RunText.sizeLabel(prompt["text"]?.stringish))").foregroundColor(AM.dim)), text: prompt["text"]?.stringish ?? "")
                if let quick = prompt["quick"]?.string {
                    ExpandView(label: AnyView(Text("a quick task's system prompt ") + Text(RunText.sizeLabel(quick)).foregroundColor(AM.dim)), text: quick)
                }
            }
            group("Tools") {
                DesignTools(tools: agent["tools"] ?? .object([:]))
                if let reach = agent["reach"]?.string { designRow("Reach") { Text(reach) } }
                if let keeps = agent["keeps"]?.string { designRow("Keeps") { Text(keeps) } }
            }
            group("Models") { DesignModels(models: agent["models"] ?? .object([:])) }
            if !timeout.isEmpty || agent["maxTurns"] != nil || agent["slots"] != nil {
                group("Limits") {
                    if !timeout.isEmpty { designRow(isBuild ? "Turn time" : "Time") { ForEach(timeout.keys.sorted(), id: \.self) { k in Text("\(k) \(RunText.msLabel(timeout[k]?.double))") } } }
                    if let turns = agent["maxTurns"]?.int { designRow("Turns") { Text("at most \(turns)") } }
                    if let slots = agent["slots"]?.object { designRow("Slots at once") { ForEach(slots.keys.sorted(), id: \.self) { k in Text("\(k) \(slots[k]!.stringish)") } } }
                }
            }
            if let ends = agent["ends"]?.array {
                group("Ends") {
                    ForEach(Array(ends.enumerated()), id: \.offset) { _, end in
                        (Text(end["line"]?.stringish ?? "") + Text(" — \(end["means"]?.stringish ?? "")").foregroundColor(AM.dim)).padding(.leading, 14).padding(.vertical, 2)
                    }
                }
            }
        }
    }
}

struct DesignTools: View {
    let tools: JSONValue
    var body: some View {
        let claude = tools["anthropic"].flatMap { $0.isNull ? JSONValue?.none : $0 }
        let codex = tools["openai"]
        VStack(alignment: .leading, spacing: 0) {
            if let claude {
                designRow("Claude") {
                    if claude["restricted"]?.truthy ?? false { Text("restricted") }
                    Text("--tools \"\(claude["tools"]?.stringish ?? "")\"")
                    if let allowed = claude["allowedTools"], !allowed.isNull { Text("--allowedTools \"\(allowed.stringish)\"") }
                    if let sources = claude["settingSources"]?.string { Text("--setting-sources \(sources)") }
                }
                if let personal = claude["personal"]?.string { designRow("Claude, also") { Text(personal) } }
                if let names = claude["engelbart"]?.array { designRow("Engelbart's MCP tools") { ForEach(Array(names.enumerated()), id: \.offset) { Text($1.stringish) } } }
                if let deny = claude["deny"]?.array { designRow("Refused to edit tools") { ExpandView(label: AnyView(Text("\(deny.count) rules")), text: deny.map(\.stringish).joined(separator: "\n"), flat: true) } }
            }
            if codex == nil || codex!.isNull {
                designRow("Codex") { Text("none (Claude Code only)").foregroundStyle(AM.dim) }
            } else if let overrides = codex!["overrides"]?.array {
                designRow("Codex") { ExpandView(label: AnyView(Text("what codexOverrides sets ") + Text("\(overrides.count) -c values").foregroundColor(AM.dim)), text: overrides.map(\.stringish).joined(separator: "\n"), flat: true) }
            } else {
                designRow("Codex") { Text("web search \((codex!["webSearch"]?.truthy ?? false) ? "on" : "off") · paper MCP \((codex!["papers"]?.truthy ?? false) ? "on" : "off") · sandbox \(codex!["sandbox"]?.stringish ?? "")") }
            }
        }
    }
}

struct DesignModels: View {
    let models: JSONValue
    static func stepText(_ s: JSONValue) -> String { "\(s["name"]?.stringish ?? "") (\(s["model"]?.stringish ?? "")) at \(s["effort"]?.stringish ?? "")" }
    var body: some View {
        let providers = models["providers"]?.object ?? [:]
        VStack(alignment: .leading, spacing: 0) {
            if let rule = models["rule"]?.string {
                designRow("Rule") {
                    Text(rule)
                    if let fallback = models["fallback"], !fallback.isNull { Text("now \(Self.stepText(fallback))").foregroundStyle(AM.dim) }
                }
            }
            if let error = models["error"]?.string { Text(error).foregroundStyle(AM.error).padding(.leading, 14) }
            ForEach(providers.keys.sorted(), id: \.self) { provider in
                let set = providers[provider]!
                designRow("\(provider)\(models["inForce"]?.string == provider ? " (in force)" : "")") {
                    if let error = set["error"]?.string { Text(error).foregroundStyle(AM.error) }
                    else if let steps = set["steps"]?.array { ForEach(Array(steps.enumerated()), id: \.offset) { i, s in Text("\(i > 0 ? "→ " : "")\(Self.stepText(s))") } }
                    else if let modes = set["modes"]?.object {
                        ForEach(DesignBody.modes.filter { modes[$0] != nil } + modes.keys.filter { !DesignBody.modes.contains($0) }.sorted(), id: \.self) { mode in
                            Text("\(mode): \((modes[mode]?.array ?? []).map(Self.stepText).joined(separator: " → "))")
                        }
                    }
                    if let offered = set["models"]?.array {
                        Text("offers \(offered.map { "\($0["name"]?.stringish ?? "") (\($0["model"]?.stringish ?? ""))" }.joined(separator: ", ")) at \((set["efforts"]?.array ?? []).map(\.stringish).joined(separator: ", "))").foregroundStyle(AM.dim)
                    }
                }
            }
        }
    }
}
