import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

/// Review's state (BuildReview.jsx, 2026-09-25 B14; what runs first since 2026-09-29): it opens on Running when the run
/// step got something running (one entry per runnable; a click opens it), else on Changes (the files, then the diff; what
/// did not run and why above it). The run step's own changes are a section apart.
public struct BuildReviewModel: Sendable {
    public static let statusWords = ["A": "added", "M": "changed", "D": "deleted", "R": "renamed", "C": "copied", "T": "changed"]
    public static let kinds = ["ui": "web UI", "app": "desktop app", "terminal": "terminal program"]
    public static let opens = ["ui": "Open in the Stage", "app": "Bring its window forward", "terminal": "Open in the terminal"]

    public var runnables: [JSONValue]
    public var runs: Bool
    public var failed: [JSONValue]

    public init(task: JSONValue?) {
        runnables = task?["runStep"]?["runnables"]?.array ?? []
        runs = runnables.contains { $0["status"]?.string == "running" }
        failed = runnables.filter { $0["status"]?.string == "failed" }
    }

    /// The view it opens on: running when something runs, else changes (no tabs at all when nothing ran).
    public var initialView: String { runs ? "running" : "changes" }
    public var hasTabs: Bool { !runnables.isEmpty }
    public func shown(_ view: String) -> String { runnables.isEmpty ? "changes" : view }

    public static func whereText(_ item: JSONValue) -> String {
        if item["status"]?.string == "running" { return item["type"]?.string == "app" ? "runs in its own window" : item["url"]?.string.map { "runs at \($0)" } ?? "runs" }
        return ["failed": "did not run", "stopped": "stopped", "installing": "installing", "checking": "checking"][item["status"]?.string ?? ""] ?? "waiting"
    }

    /// A patch line's look (lineStyle).
    public static func lineTone(_ line: String) -> String {
        if line.hasPrefix("diff --git") { return "file" }
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("index ") || line.range(of: "^(new|deleted) file mode|^similarity index|^rename (from|to)", options: .regularExpression) != nil { return "meta" }
        if line.hasPrefix("@@") { return "hunk" }
        if line.hasPrefix("+") { return "add" }
        if line.hasPrefix("-") { return "del" }
        return "ctx"
    }
}

public struct BuildReviewView: View {
    let title: String
    let review: JSONValue?
    let error: String
    let model: BuildReviewModel
    let onOpen: (String) -> Void
    let onClose: () -> Void
    @State private var view: String

    /// `review`: build-review's answer (nil while reading); `task`: the Build (its runnables); `onOpen(name)`: a runnable
    /// opened. The host leaves the right pane uncovered while Running shows (`aside`).
    public init(title: String, review: JSONValue?, error: String = "", task: JSONValue?, onOpen: @escaping (String) -> Void, onClose: @escaping () -> Void) {
        self.title = title; self.review = review; self.error = error; self.onOpen = onOpen; self.onClose = onClose
        let m = BuildReviewModel(task: task)
        self.model = m
        _view = State(initialValue: m.initialView)
    }

    public var shown: String { model.shown(view) }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Review").font(Font(Fonts.sans(15, weight: 600))).foregroundColor(.bInk)
                Text(title).font(Font(Fonts.sans(15))).foregroundColor(.bMut).lineLimit(1)
                Spacer(minLength: 0)
                if model.hasTabs {
                    HStack(spacing: 14) { tab("running", "Running"); tab("changes", "Changes") }
                }
                if shown == "changes", let from = review?["from"]?.string {
                    Text("since \(from)\(review?["base"]?.string.map { " at \($0.prefix(7))" } ?? "")").font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt)
                }
                Button(action: onClose) { Text("×").font(Font(Fonts.sans(18))).foregroundColor(.bFnt) }.buttonStyle(.plain).accessibilityLabel("Close")
            }
            .padding(.top, 14).padding(.horizontal, 18).padding(.bottom, 10)
            ScrollView {
                if shown == "running" {
                    VStack(spacing: 8) { ForEach(Array(model.runnables.enumerated()), id: \.offset) { _, item in runnable(item) } }.padding(.top, 14).padding(.horizontal, 18).padding(.bottom, 18)
                } else { changes.padding(.top, 10).padding(.horizontal, 18).padding(.bottom, 18) }
            }
        }
        .frame(maxWidth: 980)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.bBd, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.08), radius: 16, y: 12)
        .onExitCommand(perform: onClose)
    }

    func tab(_ id: String, _ label: String) -> some View {
        Button { view = id } label: {
            Text(label).font(Font(Fonts.sans(13, weight: shown == id ? 600 : 400))).foregroundColor(shown == id ? .bInk : .bMut)
                .padding(.bottom, 2).overlay(alignment: .bottom) { Rectangle().fill(shown == id ? Color.bInk : .clear).frame(height: 2) }
        }.buttonStyle(.plain)
    }

    func runnable(_ item: JSONValue) -> some View {
        let runs = item["status"]?.string == "running"
        let type = item["type"]?.string ?? ""
        let folder = item["folder"]?.string ?? "."
        return Button { if runs { onOpen(item["name"]?.string ?? "") } } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(item["name"]?.string ?? "").font(Font(Fonts.sans(13, weight: 600))).foregroundColor(.bInk)
                    Text("\(BuildReviewModel.kinds[type] ?? type)\(folder != "." ? " · \(folder)" : "")").font(Font(Fonts.sans(13))).foregroundColor(.bFnt)
                    Text(BuildReviewModel.whereText(item)).font(Font(Fonts.sans(13))).lineLimit(1)
                        .foregroundColor(runs ? .bAddInk : item["status"]?.string == "failed" ? .bDel : .bFnt)
                    Spacer(minLength: 0)
                    if runs { Text(BuildReviewModel.opens[type] ?? "").font(Font(Fonts.sans(13))).foregroundColor(.bAcc) }
                }
                if item["status"]?.string == "failed", let error = item["error"]?.string {
                    ScrollView { Text(error).font(Font(Fonts.mono(12))).foregroundColor(.bMut).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 140)
                }
            }
            .padding(.vertical, 10).padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.bBd, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!runs).help(runs ? BuildReviewModel.opens[type] ?? "" : "")
    }

    @ViewBuilder var changes: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !model.runs && !model.failed.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(model.failed.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 2) {
                            (Text(item["name"]?.string ?? "").font(Font(Fonts.sans(13, weight: 600))).foregroundColor(.bInk)
                             + Text(" \(BuildReviewModel.kinds[item["type"]?.string ?? ""] ?? "") ").font(Font(Fonts.sans(13))).foregroundColor(.bFnt)
                             + Text("did not run").font(Font(Fonts.sans(13))).foregroundColor(.bDel))
                            if let error = item["error"]?.string { Text(error).font(Font(Fonts.mono(12))).foregroundColor(.bMut) }
                        }
                    }
                }.padding(.bottom, 14)
            }
            if !error.isEmpty { Text(error).font(Font(Fonts.sans(13))).foregroundColor(.bDel) }
            if review == nil && error.isEmpty { Text("Reading…").font(Font(Fonts.sans(13))).foregroundColor(.bFnt) }
            if let review {
                files(review["files"]?.array ?? [])
                if (review["files"]?.array ?? []).isEmpty { Text("Nothing has changed yet.").font(Font(Fonts.sans(13))).foregroundColor(.bFnt) }
                if review["running"]?.bool == true { Text("Still working: this is what its last finished turn saved.").font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt) }
                patch(review["patch"]?.string ?? "").padding(.top, 10)
                if review["truncated"]?.bool == true { Text("The diff is longer than this; the rest is cut.").font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt).padding(.top, 8) }
                if let run = review["runStep"], !(run["files"]?.array ?? []).isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("Run step").font(Font(Fonts.sans(13.5, weight: 600))).foregroundColor(.bInk)
                            Text(run["apart"]?.bool == true ? "changed to make it run, apart from the Build's work above" : "changed to make it run; a later turn changed the same lines, so the Build's work above includes these too")
                                .font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt)
                        }
                        files(run["files"]?.array ?? [])
                        patch(run["patch"]?.string ?? "")
                        if run["truncated"]?.bool == true { Text("The diff is longer than this; the rest is cut.").font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt) }
                    }.padding(.top, 22)
                }
            }
        }
    }

    func files(_ list: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(list.enumerated()), id: \.offset) { _, f in
                HStack(spacing: 10) {
                    Text(f["was"]?.string.map { "\($0) → \(f["path"]?.string ?? "")" } ?? f["path"]?.string ?? "").font(Font(Fonts.mono(13))).foregroundColor(.bInk).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(BuildReviewModel.statusWords[f["status"]?.string ?? ""] ?? f["status"]?.string ?? "").font(Font(Fonts.sans(13))).foregroundColor(.bFnt)
                    Group {
                        if f["binary"]?.bool == true { Text("binary") }
                        else { Text("+\(f["adds"]?.int ?? 0)").foregroundColor(.bAddInk) + Text(" −\(f["dels"]?.int ?? 0)").foregroundColor(.bDelInk) }
                    }.font(Font(Fonts.mono(13))).frame(width: 90, alignment: .trailing)
                }
            }
        }
    }

    func patch(_ text: String) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                let tone = BuildReviewModel.lineTone(line)
                Text(line.isEmpty ? " " : line)
                    .font(Font(Fonts.mono(12.5, weight: tone == "file" ? 600 : 400)))
                    .foregroundColor(tone == "file" ? .bInk : tone == "meta" ? .bFnt : tone == "hunk" ? .bHunk : tone == "add" ? .bAddInk : tone == "del" ? .bDelInk : .bMut)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(tone == "add" ? Color.bAddBg : tone == "del" ? Color.bDelBg : .clear)
                    .padding(.top, tone == "file" ? 14 : 0)
                    .textSelection(.enabled)
            }
        }
    }
}

/// Reject (BuildReject.jsx, 2026-09-29; it replaced Discard's second click): asks before a Build's code changes, its copy
/// and its branch are deleted. Escape or a click outside cancels.
public struct BuildRejectView: View {
    let title: String
    let onConfirm: () async -> Void
    let onClose: () -> Void
    @State private var busy = false

    public init(title: String, onConfirm: @escaping () async -> Void, onClose: @escaping () -> Void) { self.title = title; self.onConfirm = onConfirm; self.onClose = onClose }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reject this Build?").font(Font(Fonts.sans(16, weight: 600))).foregroundColor(.bInk)
            if !title.isEmpty { Text(title).font(Font(Fonts.sans(13))).foregroundColor(.bFnt).lineLimit(1) }
            Text("This deletes its code changes and its branch. It can't be undone.").font(Font(Fonts.sans(14))).foregroundColor(.bMut)
            HStack(spacing: 8) {
                Spacer()
                Button(action: onClose) {
                    Text("Cancel").font(Font(Fonts.sans(13, weight: 500))).foregroundColor(.bMut).padding(.vertical, 9).padding(.horizontal, 16)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(NSColor(hex: "#e5e5e5")), lineWidth: 1))
                }.buttonStyle(.plain).disabled(busy).keyboardShortcut(.cancelAction)
                Button {
                    guard !busy else { return }
                    busy = true
                    Task { await onConfirm(); onClose() }
                } label: {
                    Text(busy ? "Deleting…" : "Delete changes").font(Font(Fonts.sans(13, weight: 500))).foregroundColor(.white).padding(.vertical, 9).padding(.horizontal, 16)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.bDel)).opacity(busy ? 0.6 : 1)
                }.buttonStyle(.plain).disabled(busy)
            }.padding(.top, 12)
        }
        .padding(20)
        .frame(width: 400, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
        .shadow(color: Color.black.opacity(0.18), radius: 20, y: 10)
        .onExitCommand { if !busy { onClose() } }
    }
}

/// A `build> <id>` line's card (DocEditor.jsx), drawn from BuildCardModel; `onAct(act, run)` is the card's button. The
/// reply field's text stays the host's (`reply` binding) so a redraw never loses it.
public struct BuildCardView: View {
    let card: BuildCardModel
    let diff: JSONValue?
    @Binding var reply: String
    let onAct: (String, String?) -> Void
    @State private var promptOpen = false

    public init(card: BuildCardModel, diff: JSONValue?, reply: Binding<String>, onAct: @escaping (String, String?) -> Void) {
        self.card = card; self.diff = diff; self._reply = reply; self.onAct = onAct
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Build").font(Font(Fonts.sans(14, weight: 600))).foregroundColor(.bInk)
                Text(card.title).font(Font(Fonts.sans(14))).foregroundColor(card.missing ? .bFnt : .bInk).lineLimit(1)
                Spacer(minLength: 0)
                if !card.missing {
                    Text("\(card.model) · \(card.effort)").font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt)
                    Text(card.status).font(Font(Fonts.sans(12.5, weight: 500))).foregroundColor(card.statusTone == "blue" ? .bAcc : card.statusTone == "red" ? .bDel : .bFnt)
                }
            }
            if let prompt = card.prompt {
                Button { promptOpen.toggle() } label: { Text("Prompt \(promptOpen ? "⌃" : "⌄")").font(Font(Fonts.sans(13))).foregroundColor(.bFnt) }.buttonStyle(.plain).padding(.top, 6)
                if promptOpen { ScrollView { Text(prompt).font(Font(Fonts.sans(15))).foregroundColor(.bMut).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 320).padding(.horizontal, 12).background(Color.white).cornerRadius(8) }
            }
            if card.hiddenMessages > 0 { act(.init(act: "buildhistory", label: "\(card.hiddenMessages) earlier \(card.hiddenMessages == 1 ? "message" : "messages")", style: "text")) }
            ForEach(Array(card.messages.enumerated()), id: \.offset) { _, m in message(m) }
            if let q = card.question {
                (Text("Needs you: ").font(Font(Fonts.sans(14, weight: 600))) + Text(q)).foregroundColor(.bInk)
                    .padding(.vertical, 8).padding(.horizontal, 12).frame(maxWidth: .infinity, alignment: .leading).background(Color.white)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.bAcc).frame(width: 2) }.padding(.top, 10)
            }
            if let e = card.escalation { Text(e).foregroundColor(.bInk).padding(.top, 10) }
            if let checks = card.failedChecks {
                Text("$ \(checks.command)\n\(checks.output)").font(Font(Fonts.mono(12))).foregroundColor(.bMut).padding(.vertical, 8).padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading).background(Color.white).cornerRadius(6).padding(.top, 8)
            }
            if let sending = card.sending { Text("Sending: \(sending)").font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt).padding(.top, 8) }
            if let label = card.runLabel {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 10) {
                        Text(label).font(Font(Fonts.sans(12.5, weight: 500))).foregroundColor(.bInk)
                        Text(card.runNote ?? "").font(Font(Fonts.sans(12.5))).foregroundColor(card.runFailed ? .bDel : .bFnt).lineLimit(1)
                        Spacer(minLength: 0)
                        ForEach(Array(card.runActions.enumerated()), id: \.offset) { _, a in act(a) }
                    }
                    ForEach(Array(card.runRows.enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(row.name).foregroundColor(.bInk)
                            Text(row.kind).foregroundColor(.bFnt)
                            Text(row.state + (row.error.map { " · \($0)" } ?? "")).lineLimit(1)
                                .foregroundColor(row.tone == "green" ? .bAddInk : row.tone == "red" ? .bDel : .bFnt)
                            Spacer(minLength: 0)
                            ForEach(Array(row.actions.enumerated()), id: \.offset) { _, a in act(a) }
                        }.font(Font(Fonts.sans(12.5)))
                    }
                }
                .padding(.vertical, 8).padding(.horizontal, 12).background(Color.white).cornerRadius(8).padding(.top, 10)
            }
            if let doing = card.doing {
                HStack(spacing: 10) {
                    Text(doing).font(Font(Fonts.sans(13))).foregroundColor(.bFnt).lineLimit(1)
                    Spacer(minLength: 0)
                    if card.canStop { act(.init(act: "buildstop", label: "Stop", style: "text")) }
                }.padding(.top, 10)
            }
            if let diff, let files = diff["files"]?.array, !files.isEmpty { diffBox(diff, files) }
            if let placeholder = card.replyPlaceholder {
                HStack(alignment: .top, spacing: 10) {
                    TextField(placeholder, text: $reply, axis: .vertical).textFieldStyle(.plain).font(Font(Fonts.sans(15))).foregroundColor(.bInk)
                        .onSubmit { onAct("buildsend", nil) }
                    Button { onAct("buildsend", nil) } label: {
                        Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold)).frame(width: 26, height: 26)
                            .background(Circle().fill(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.bHov : Color.bAcc))
                            .foregroundColor(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .bFnt : .white)
                    }.buttonStyle(.plain).accessibilityLabel("Send")
                }.padding(.top, 12)
            }
            if let error = card.errorLine { Text(error).font(Font(Fonts.sans(12.5))).foregroundColor(.bDel).padding(.top, 8) }
            if !card.actions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(card.actions.enumerated()), id: \.offset) { i, a in
                        if a.act == "buildreject" { Spacer(minLength: 0) }
                        act(a)
                    }
                }.padding(.top, 12)
            }
        }
        .font(Font(Fonts.sans(14)))
        .foregroundColor(.bMut)
        .padding(.top, 12).padding(.horizontal, 16).padding(.bottom, 14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.bPanel2))
    }

    @ViewBuilder func message(_ m: JSONValue) -> some View {
        let text = m["text"]?.string ?? ""
        switch m["role"]?.string {
        case "engelbart": Text(text).font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt).padding(.vertical, 4)
        case "you": Text(text).foregroundColor(.bInk).padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(Color.bBd2).frame(width: 2) }.padding(.top, 10).padding(.bottom, 6)
        default: Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
            .font(Font(Fonts.sans(15))).foregroundColor(.bMut).textSelection(.enabled).padding(.vertical, 6)
        }
    }

    func act(_ a: BuildCardModel.Action) -> some View {
        Button { onAct(a.act, a.run) } label: {
            Text(a.label).font(Font(Fonts.sans(13, weight: a.style == "text" ? 400 : 500)))
                .foregroundColor(a.style == "primary" ? .white : a.disabled ? Color(NSColor(hex: "#b3b3b3")) : a.style == "text" ? .bFnt : .bMut)
                .padding(.vertical, a.style == "text" ? 0 : a.style == "primary" ? 9 : 8).padding(.horizontal, a.style == "text" ? 0 : a.style == "primary" ? 16 : 12)
                .background(RoundedRectangle(cornerRadius: 8).fill(a.style == "primary" ? Color.bAcc.opacity(a.disabled ? 0.45 : 1) : a.style == "box" ? Color.white : .clear))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(a.style == "box" ? Color(NSColor(hex: "#e5e5e5")) : .clear, lineWidth: 1))
        }.buttonStyle(.plain).disabled(a.disabled).help(a.title)
    }

    /// What the Build has changed since it started, streamed while it works: a count, then the diff in a box of its own
    /// height (260) that scrolls, each file's header held at its top.
    func diffBox(_ diff: JSONValue, _ files: [JSONValue]) -> some View {
        let totals = BuildDiffRows.totals(files)
        let rows = BuildDiffRows.rows(diff)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("\(totals.files) \(totals.files == 1 ? "file" : "files") changed")
                Text("+\(totals.adds)").foregroundColor(.bAddInk)
                Text("−\(totals.dels)").foregroundColor(.bDelInk)
            }.font(Font(Fonts.sans(12.5))).foregroundColor(.bFnt)
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                    ForEach(Array(rows.rows.enumerated()), id: \.offset) { _, row in
                        if row.kind == "file" {
                            HStack(spacing: 8) {
                                Text(row.was.map { "\($0) → \(row.path)" } ?? row.path).font(Font(Fonts.sans(12.5, weight: 500))).foregroundColor(.bInk).lineLimit(1)
                                Spacer(minLength: 0)
                                if row.binary { Text("binary") } else { Text("+\(row.adds)").foregroundColor(.bAddInk); Text("−\(row.dels)").foregroundColor(.bDelInk) }
                            }.font(Font(Fonts.sans(12.5))).padding(.vertical, 6).padding(.horizontal, 10).background(Color(NSColor(hex: "#f5f5f5")))
                        } else {
                            Text(row.text.isEmpty ? " " : row.text).font(Font(row.kind == "note" ? Fonts.sans(12) : Fonts.mono(12)))
                                .foregroundColor(row.kind == "hunk" || row.kind == "note" ? .bFnt : row.kind == "ctx" ? .bMut : .bInk)
                                .padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(row.kind == "add" ? Color(NSColor(hex: "#e6ffec")) : row.kind == "del" ? Color(NSColor(hex: "#ffebe9")) : row.kind == "hunk" ? Color(NSColor(hex: "#f8f8ff")) : .clear)
                        }
                    }
                    if rows.cut > 0 || rows.truncated { Text("The diff is longer than this; the rest is cut.").font(Font(Fonts.sans(12))).foregroundColor(.bFnt).padding(.vertical, 4).padding(.horizontal, 10) }
                }
            }
            .frame(maxHeight: 260)
            .background(Color.white)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(NSColor(hex: "#ededed")), lineWidth: 1))
        }.padding(.top, 10)
    }
}
