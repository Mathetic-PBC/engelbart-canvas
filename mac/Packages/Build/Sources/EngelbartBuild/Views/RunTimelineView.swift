import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

/// The sandbox run's pipeline list (RunTimeline.jsx, run-timeline.css): a row per step (state icon, number and title
/// 130 wide, summary, chevron, duration 54 wide), each step's output under its row when opened; durations tick each
/// second while a step runs. Geist 13/1.5, rows 8×22 padding, hairlines #e5e5e5.
public struct RunTimelineView: View {
    let run: JSONValue?
    let repoName: String
    let onOpenPreview: (() -> Void)?
    @State private var expanded: String?
    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    public init(run: JSONValue?, repoName: String, onOpenPreview: (() -> Void)? = nil) { self.run = run; self.repoName = repoName; self.onOpenPreview = onOpenPreview }

    static let timelineInk = Color(NSColor(hex: "#0a0a0a")), line = Color(NSColor(hex: "#e5e5e5")), summary = Color(NSColor(hex: "#737373"))
    static let failedRed = Color(NSColor(hex: "#ef4444")), warned = Color(NSColor(hex: "#a66b12")), done = Color(NSColor(hex: "#262626")), logInk = Color(NSColor(hex: "#404040"))

    /// What the summary says for a done step (stepSummary: presentation copy only).
    public static func stepSummary(_ step: RunStepRow) -> String {
        guard step.state == "done" else { return step.summary }
        if step.id == "start" {
            if step.events.last(where: { $0.ds("phase") == "setup" })?.ds("status") == "done" { return step.title == "Restart application" ? "Application restarted" : "Repository prepared" }
            if ["Installing and preparing…", "Preparing repository…", "Replaying saved setup…", "Restarting application…", "Switching setup provider…", "Starting…"].contains(step.summary) { return "Setup activity recorded" }
        }
        if step.id == "health" && step.summary == "The check passed" { return "Check passed" }
        if step.id == "sandbox", step.summary.range(of: #"^Sandbox (running|stopped).* · cloning"#, options: .regularExpression) != nil { return step.summary.components(separatedBy: " · cloning")[0] }
        return step.summary
    }

    public var body: some View {
        let steps = CanvasBuild.steps(run, repoName: repoName)
        VStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                row(step, index)
                if index < steps.count - 1 { Rectangle().fill(RunTimelineView.line).frame(height: 1) }
            }
        }
        .font(Font(Fonts.geist(13)))
        .foregroundColor(RunTimelineView.timelineInk)
        .onReceive(tick) { if steps.contains(where: { $0.since != nil }) { now = $0 } }
    }

    @ViewBuilder func row(_ step: RunStepRow, _ index: Int) -> some View {
        let has = !step.events.isEmpty || step.error != nil || (step.id == "live" && onOpenPreview != nil)
        let duration = RunSteps.stepDuration(step, now: now.timeIntervalSince1970 * 1000)
        VStack(spacing: 0) {
            Button { if has { expanded = expanded == step.id ? nil : step.id } } label: {
                HStack(spacing: 12) {
                    stateIcon(step.state)
                    HStack(spacing: 6) {
                        Text("\(index + 1)").foregroundColor(Color(NSColor(hex: "#737373")).opacity(["skipped", "waiting"].contains(step.state) ? 0.7 : 0.5))
                        Text(step.title).foregroundColor(step.state == "failed" ? RunTimelineView.failedRed : step.state == "waiting" ? RunTimelineView.summary.opacity(0.6) : RunTimelineView.timelineInk)
                    }.frame(width: 130, alignment: .leading)
                    Text(RunTimelineView.stepSummary(step)).lineLimit(1).truncationMode(.tail)
                        .foregroundColor(step.state == "failed" ? RunTimelineView.failedRed.opacity(0.9) : ["skipped", "waiting"].contains(step.state) ? Color(NSColor(hex: "#969696")) : RunTimelineView.summary)
                        .frame(maxWidth: .infinity, alignment: .leading).help(RunTimelineView.stepSummary(step))
                    if has { Image(systemName: "chevron.right").font(.system(size: 10)).rotationEffect(.degrees(expanded == step.id ? 90 : 0)).foregroundColor(step.state == "failed" ? RunTimelineView.failedRed : RunTimelineView.summary).opacity(expanded == step.id || step.state == "failed" ? 1 : 0.55) }
                    Text(duration != nil && step.state != "waiting" ? RunSteps.formatDuration(duration!) : "").font(Font(Fonts.geist(12))).foregroundColor(RunTimelineView.summary.opacity(0.7)).frame(width: 54, alignment: .trailing)
                }
                .padding(.vertical, 8).padding(.horizontal, 22)
                .background(step.state == "failed" ? RunTimelineView.failedRed.opacity(0.03) : .clear)
                .contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!has)
            if has && expanded == step.id {
                RunLogView(lines: BuildEvents.terminalLines(step.events), error: step.error, following: step.since != nil, onOpenPreview: step.id == "live" ? onOpenPreview : nil)
                    .frame(maxHeight: 220).background(Color(NSColor(hex: "#fafafa")))
                    .overlay(alignment: .top) { Rectangle().fill(RunTimelineView.line).frame(height: 1) }
            }
        }
    }

    @ViewBuilder func stateIcon(_ state: String) -> some View {
        ZStack {
            switch state {
            case "done": Circle().fill(RunTimelineView.done); Image(systemName: "checkmark").font(.system(size: 7, weight: .heavy)).foregroundColor(.white)
            case "warned": Circle().fill(RunTimelineView.warned); Text("!").font(.system(size: 9, weight: .heavy)).foregroundColor(.white)
            case "failed": Circle().fill(RunTimelineView.failedRed); Image(systemName: "xmark").font(.system(size: 7, weight: .heavy)).foregroundColor(.white)
            case "skipped": Circle().stroke(Color(NSColor(hex: "#dedede")), lineWidth: 1); Image(systemName: "minus").font(.system(size: 7, weight: .heavy)).foregroundColor(Color(NSColor(hex: "#b0b0b0")))
            case "active": ProgressView().controlSize(.mini)
            default: Circle().stroke(Color(NSColor(hex: "#d4d4d4")), lineWidth: 1)
            }
        }.frame(width: 16, height: 16).accessibilityLabel(state)
    }
}

/// A step's output (RunLog): mono 12/1.6, `$` before commands, errors red; it follows the end while the step runs.
public struct RunLogView: View {
    let lines: [BuildEvents.Line]
    let error: String?
    let following: Bool
    let onOpenPreview: (() -> Void)?
    var emptyMessage = "Nothing recorded for this step."

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    if let error { Text(error).foregroundColor(Color(NSColor(hex: "#ad3030"))).padding(.bottom, 8) }
                    ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                        HStack(spacing: 8) {
                            Text(line.kind == "command" ? "$" : "").foregroundColor(Color(NSColor(hex: "#808080"))).frame(width: 10)
                            Text(line.text).foregroundColor(line.kind == "command" ? RunTimelineView.timelineInk : line.kind == "error" ? Color(NSColor(hex: "#ad3030")) : line.kind == "status" ? Color(NSColor(hex: "#626262")) : RunTimelineView.logInk)
                                .fixedSize().textSelection(.enabled)
                        }.id(i)
                    }
                    if lines.isEmpty && error == nil && onOpenPreview == nil { Text(emptyMessage) }
                    if let onOpenPreview {
                        Button("Open preview ↗", action: onOpenPreview).buttonStyle(.plain).underline().font(Font(Fonts.sans(12))).foregroundColor(Color(NSColor(hex: "#525252"))).padding(.top, 8)
                    }
                }
                .font(.system(size: 12, design: .monospaced))
                .padding(.vertical, 8).padding(.leading, 32).padding(.trailing, 22)
            }
            .onChange(of: lines.count) { _, n in if following && n > 0 { proxy.scrollTo(n - 1, anchor: .bottom) } }
        }
    }
}

/// The repository build inspector (BuildDetails.jsx, build-details.css): a modal 760×640 (radius 8, hairline #e2e2e2)
/// with the repository and its runtime status, tabs Build / Logs / Environment, "Time to live", the error, and the
/// footer actions (Open terminal, Open preview, Run / Retry build, Stop sandbox). The Environment tab is the Sandbox
/// package's panel (`environment`).
public struct BuildDetailsView<Environment: View>: View {
    public struct Actions {
        public var openPreview: () -> Void
        public var openTerminal: (() -> Void)?
        public var start: () -> Void
        public var stop: () -> Void
        public var visitRepository: () -> Void
        public var close: () -> Void
        public init(openPreview: @escaping () -> Void, openTerminal: (() -> Void)?, start: @escaping () -> Void, stop: @escaping () -> Void, visitRepository: @escaping () -> Void, close: @escaping () -> Void) {
            self.openPreview = openPreview; self.openTerminal = openTerminal; self.start = start; self.stop = stop; self.visitRepository = visitRepository; self.close = close
        }
    }

    let repoName: String
    let run: JSONValue?
    let message: String?
    let error: String?
    let working: Bool
    /// sandbox-notifications.js canOpenPreview / canOpenTerminal, as the Sandbox package decides them.
    let canPreview: Bool
    let canTerminal: Bool
    let actions: Actions
    let environment: () -> Environment
    @State private var tab = "build"
    @State private var environmentVisited = false

    public init(repoName: String, run: JSONValue?, message: String? = nil, error: String? = nil, working: Bool = false, canPreview: Bool, canTerminal: Bool,
                actions: Actions, @ViewBuilder environment: @escaping () -> Environment) {
        self.repoName = repoName; self.run = run; self.message = message; self.error = error; self.working = working
        self.canPreview = canPreview; self.canTerminal = canTerminal; self.actions = actions; self.environment = environment
    }

    /// repoToolbarStatus.
    public static func toolbarStatus(_ run: JSONValue?, canPreview: Bool) -> (label: String, kind: String) {
        switch run?["status"]?.string {
        case "starting": return ("Preparing…", "starting")
        case "failed": return ("Needs attention", "failed")
        case "ready": return canPreview ? ("Live", "live") : ("Ready", "ready")
        default: return ("Inactive", "inactive")
        }
    }

    public var body: some View {
        let status = BuildDetailsView.toolbarStatus(run, canPreview: canPreview)
        let active = ["starting", "ready"].contains(run?["status"]?.string ?? "")
        let terminal = actions.openTerminal != nil && canTerminal
        let log = run?["build_log"]?.array ?? []
        let ttl = CanvasBuild.timeToLive(run)
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button(action: actions.visitRepository) { Text(repoName).font(Font(Fonts.sans(13, weight: 500))).foregroundColor(Color(NSColor(hex: "#333333"))) }.buttonStyle(.plain).help("Open \(repoName) on GitHub")
                Text("/").foregroundColor(Color(NSColor(hex: "#b3b3b3")))
                Button(action: actions.openPreview) {
                    HStack(spacing: 6) {
                        if status.kind == "starting" { ProgressView().controlSize(.mini) }
                        else if status.kind == "failed" { Image(systemName: "exclamationmark.triangle").font(.system(size: 11)) }
                        else { Circle().fill(status.kind == "live" ? Color(NSColor(hex: "#639b76")) : .clear).overlay(Circle().stroke(status.kind == "live" ? Color(NSColor(hex: "#639b76")) : Color(NSColor(hex: "#a3a3a3")), lineWidth: 1)).frame(width: 6, height: 6) }
                        Text(status.label)
                    }.font(Font(Fonts.sans(13))).foregroundColor(status.kind == "failed" ? Color(NSColor(hex: "#a14343")) : status.kind == "live" ? .bMut : Color(NSColor(hex: "#737373")))
                }.buttonStyle(.plain).disabled(status.kind != "live" || working)
                Spacer()
                Button(action: actions.close) { Text("×").font(.system(size: 20)).foregroundColor(Color(NSColor(hex: "#666666"))) }.buttonStyle(.plain).help("Close").accessibilityLabel("Close build details")
            }.padding(.horizontal, 22).frame(minHeight: 44)
            Rectangle().fill(Color.bBd).frame(height: 1)
            HStack {
                HStack(spacing: 22) {
                    ForEach(["build", "logs", "environment"], id: \.self) { value in
                        Button { tab = value; if value == "environment" { environmentVisited = true } } label: {
                            Text(value.prefix(1).uppercased() + value.dropFirst()).font(Font(Fonts.sans(13))).foregroundColor(tab == value ? .bInk : Color(NSColor(hex: "#737373")))
                                .padding(.vertical, 8).overlay(alignment: .bottom) { Rectangle().fill(tab == value ? Color.bInk : .clear).frame(height: 2) }
                        }.buttonStyle(.plain)
                    }
                }
                Spacer()
                if let ttl { (Text("Time to live ").foregroundColor(Color(NSColor(hex: "#8a8a8a"))) + Text(RunSteps.formatDuration(ttl)).foregroundColor(Color(NSColor(hex: "#525252")))).font(Font(Fonts.sans(12))).help("Wall-clock time from setup start (or the latest restart) to the first verified live preview.") }
            }.padding(.horizontal, 22)
            Rectangle().fill(Color.bBd).frame(height: 1)
            if let error { Text(error).foregroundColor(Color(NSColor(hex: "#cc2222"))).padding(.horizontal, 22).padding(.vertical, 16) }
            Group {
                switch tab {
                case "build":
                    ScrollView {
                        RunTimelineView(run: run, repoName: repoName, onOpenPreview: status.kind == "live" ? actions.openPreview : nil).padding(.top, 6)
                        if let e = run?["error"]?.string { Text(e).foregroundColor(Color(NSColor(hex: "#cc2222"))).padding(.horizontal, 22).padding(.vertical, 16) }
                        if log.isEmpty { Text(message ?? (run != nil ? "Earlier build details are unavailable. New build activity will appear here." : "Build progress will appear here when setup starts.")).foregroundColor(Color(NSColor(hex: "#737373"))).padding(.horizontal, 22).padding(.vertical, 16) }
                    }
                case "logs":
                    RunLogView(lines: BuildEvents.terminalLines(CanvasBuild.buildEvents(run)), error: run?["error"]?.string, following: run?["status"]?.string == "starting", onOpenPreview: nil,
                               emptyMessage: run != nil ? "No logs recorded for this run." : "Logs will appear when setup starts.")
                default:
                    if environmentVisited { environment() }
                }
            }.frame(maxHeight: .infinity)
            Rectangle().fill(Color.bBd).frame(height: 1)
            HStack(spacing: 14) {
                Spacer()
                if active && terminal { footerButton("Open terminal", primary: !canPreview, action: actions.openTerminal!) }
                if active { if !terminal || canPreview { footerButton("Open preview", primary: true, disabled: status.kind != "live", action: actions.openPreview) } }
                else { footerButton(run != nil ? "Retry build" : "Run", primary: true, action: actions.start) }
                if active || (run?["status"]?.string == "failed" && run?["sandbox_id"]?.string != nil) { footerButton("Stop sandbox", primary: false, action: actions.stop) }
            }.padding(.vertical, 8).padding(.horizontal, 22).frame(minHeight: 44)
        }
        .font(Font(Fonts.sans(13)))
        .frame(width: 760, height: 640)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(NSColor(hex: "#e2e2e2")), lineWidth: 1))
        .onExitCommand(perform: actions.close)
    }

    func footerButton(_ label: String, primary: Bool, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(Font(Fonts.sans(12))).foregroundColor(primary ? .white : Color(NSColor(hex: "#666666")))
                .padding(.vertical, primary ? 5 : 4).padding(.horizontal, primary ? 12 : 0)
                .background(RoundedRectangle(cornerRadius: 5).fill(primary ? Color.bInk : .clear))
        }.buttonStyle(.plain).disabled(working || disabled).opacity(working || disabled ? 0.5 : 1)
    }
}
