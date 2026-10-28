import AppKit
import SwiftUI
import EngelbartCore
import EngelbartUI

// src/renderer/screens/Benchmark.jsx (2026-10-13; runs and agents 2026-10-14): the Agent Viewer's Benchmark tab. Chat ·
// Brainstorm · Discover · Create across the very top (the one picked is whose questions are listed, run and exported);
// the runs as tabs, oldest first, "+ New run" after them; Run (or Stop while anything runs) on the newest run, else
// "Kept as it was answered."; Export; each note's questions under its name: the question across the top, Old and New
// beside each other, a note under the two saved 500 ms after typing (flushed when the tab is switched or closed). Plain
// on purpose: no counts, times, scores or summary.
//
// An answer is drawn as the document draws an answer's lines (doc.js parseLines/parseLine/inlineHtml/highlight). That
// reading is the Doc/Editor packages'; the app hands it in as `answerHTML` (used for the view and the export). Until then
// a plain reading stands in: headings, list marks, code fences, the rest as text.

public enum BenchmarkPage {
    static func esc(_ s: String) -> String { RunText.escape(s) }

    /// The stand-in reading of an answer as HTML: '#' headings (17/16/15, 600), '- '/'* '/'1. ' list rows with their mark,
    /// fenced code (13px mono on white between side borders), blank lines as 8px, the rest as a div each.
    public static func plainAnswerHTML(_ text: String) -> String {
        var inFence = false
        return text.components(separatedBy: "\n").map { line -> String in
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                defer { inFence.toggle() }
                let lang = line.trimmingCharacters(in: .whitespaces).dropFirst(3)
                return inFence ? "<div style=\"height:6px\"></div>" : "<div style=\"margin-top:6px;color:#8f8f8f;font:12px/1.6 var(--font-sans, system-ui)\">\(esc(lang.isEmpty ? " " : String(lang)))</div>"
            }
            if inFence { return "<div style=\"background:#fff;border:1px solid #eaeaea;border-width:0 1px;padding:0 10px;font:13px/1.6 var(--font-mono, ui-monospace, monospace);color:#171717;white-space:pre-wrap\">\(line.isEmpty ? "<br>" : esc(line))</div>" }
            if let m = re("^(#{1,3})\\s+(.*)$").groups(line) {
                return "<div style=\"font:600 \([17, 16, 15][m[1]!.count - 1])px/1.5 var(--font-sans, system-ui);color:#171717;padding-top:6px\">\(esc(m[2] ?? ""))</div>"
            }
            if let m = re("^(\\s*)([-*]|\\d+\\.)\\s+(.*)$").groups(line) {
                let depth = (m[1] ?? "").count / 2
                let mark = (m[2] == "-" || m[2] == "*") ? "•" : (m[2] ?? "")
                return "<div style=\"display:flex;gap:8px;padding:2px 0 2px \(depth * 18)px\"><span style=\"flex:none;color:#8f8f8f\">\(esc(mark))</span><span style=\"flex:1;min-width:0\">\(esc(m[3] ?? ""))</span></div>"
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty { return "<div style=\"height:8px\"></div>" }
            return "<div>\(esc(line))</div>"
        }.joined()
    }

    static let style = "body{font:14px/1.5 system-ui,sans-serif;color:#171717;max-width:1200px;margin:24px auto;padding:0 16px}h1{font-size:20px}h2{font-size:16px;margin:28px 0 6px}.dim{color:#777}.entry{border-top:1px solid #ddd;padding:10px 0 12px}.q{font-weight:600;white-space:pre-wrap;margin-bottom:6px}.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.label{color:#777;font:12px/1.4 ui-monospace,Menlo,monospace;margin-bottom:2px}.answer{color:#4d4d4d;background:#fafafa;padding:6px 12px;border-left:2px solid #dcdcdc;overflow-wrap:anywhere}.error{color:#a00}.note{margin-top:6px;padding:4px 8px;border:1px solid #ddd;white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,monospace}code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#efefef;padding:0 3px;border-radius:3px}"

    /// The name of the agent shown ("Chat" when main names none).
    public static func agentName(_ data: JSONValue?) -> String {
        (data?["agents"]?.array ?? []).first { $0["id"] == data?["agent"] }?["name"]?.string ?? "Chat"
    }

    /// When a run was started, short: "Oct 14, 3:02 PM".
    public static func runWhen(_ at: String?) -> String {
        guard let at, let date = Time.parse(at) else { return "" }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.dateFormat = "MMM d, h:mm a"
        return f.string(from: date)
    }

    /// Each change ({ run, key, new, running }) put into the list: only that entry's New, when it is in the run shown.
    public static func applyChange(_ data: JSONValue?, _ change: JSONValue?) -> JSONValue? {
        guard let data, let change else { return data }
        if let run = change["run"]?.string, let current = data["current"]?.string, run != current { return data.with("running", .bool(change["running"]?.truthy ?? false)) }
        let key = change["key"]
        let groups = (data["groups"]?.array ?? []).map { group -> JSONValue in
            guard (group["entries"]?.array ?? []).contains(where: { $0["key"] == key }) else { return group }
            return group.with("entries", .array((group["entries"]?.array ?? []).map { $0["key"] == key ? $0.with("new", change["new"] ?? .object([:])) : $0 }))
        }
        return data.with("running", .bool(change["running"]?.truthy ?? false)).with("groups", .array(groups))
    }

    /// The run shown as one page to save: its name and when it ran, then by note each question, its Old and New answers
    /// and the note (`notes`: typed and not saved yet, ahead of what is kept), and the same as JSON at the end.
    public static func html(_ data: JSONValue, notes: [String: String] = [:], exported: String = Time.iso(), answerHTML: @escaping (String) -> String = plainAnswerHTML) -> String {
        let run = (data["runs"]?.array ?? []).first { $0["id"] == data["current"] }
        let title = "\(agentName(data)) benchmark: \(run?["name"]?.stringish ?? "answers")"
        let noteOf = { (e: JSONValue) -> String in notes[e["key"]?.stringish ?? ""] ?? e["note"]?.stringish ?? "" }
        let newHtml = { (v: JSONValue?) -> String in
            if let a = v?["answer"]?.string { return "<div class=\"answer\">\(answerHTML(a))</div>" }
            if let e = v?["error"]?.string { return "<div class=\"error\">\(esc(e))</div>" }
            return "<div class=\"dim\">\((v?["running"]?.truthy ?? false) ? "Still running when exported." : "Not asked in this run.")</div>"
        }
        let groups = data["groups"]?.array ?? []
        let body = groups.map { g in
            "<h2>\(esc(g["name"]?.stringish ?? ""))</h2>" + (g["entries"]?.array ?? []).map { e in
                "<div class=\"entry\"><div class=\"q\">\(esc(e["question"]?.stringish ?? ""))</div><div class=\"cols\"><div><div class=\"label\">Old</div><div class=\"answer\">\(answerHTML(e["old"]?.stringish ?? ""))</div></div><div><div class=\"label\">New</div>\(newHtml(e["new"]))</div></div>\(noteOf(e).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "<div class=\"note\">\(esc(noteOf(e)))</div>")</div>"
            }.joined()
        }.joined()
        let entries: [JSONValue] = groups.flatMap { g in (g["entries"]?.array ?? []).map { e -> JSONValue in
            ["note": g["rel"] ?? "", "question": e["question"] ?? "", "old": e["old"] ?? "", "new": e["new"]?["answer"]?.string.map { .string($0) } ?? .null,
             "error": e["new"]?["error"]?.string.map { .string($0) } ?? .null, "notes": .string(noteOf(e))]
        } }
        let json = JSONText.stringify(["agent": data["agent"] ?? "bart", "run": run.map { ["id": $0["id"] ?? .null, "name": $0["name"] ?? .null, "at": $0["at"] ?? .null] } ?? .null,
                                       "exported": .string(exported), "entries": .array(entries)]).replacingOccurrences(of: "<", with: "\\u003c")
        let when = runWhen(run?["at"]?.string)
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>\(esc(title))</title><style>\(style)</style></head><body><h1>\(esc(title))</h1><div class=\"dim\">\(when.isEmpty ? "" : "Run \(esc(when)). ")Exported from Engelbart's Agent Viewer, \(esc(exported)).</div>\(body)<script type=\"application/json\" id=\"chat-benchmark\">\(json)</script></body></html>"
    }
}

@MainActor
public final class BenchmarkModel: ObservableObject {
    @Published public private(set) var data: JSONValue?
    @Published public var notes: [String: String] = [:]
    @Published public var error = ""
    @Published public var said = ""
    let channels: AgentMapChannels
    private var timers: [String: DispatchWorkItem] = [:]
    private var typed: [String: String] = [:]
    private var token: EventHub.Token?
    private let hub: EventHub
    static let noteSaveMs = 0.5

    public init(channels: AgentMapChannels, hub: EventHub = .shared) {
        self.channels = channels
        self.hub = hub
        token = hub.on("engelbart:chat-benchmark") { [weak self] change in MainActor.assumeIsolated { self?.data = BenchmarkPage.applyChange(self?.data, change) } }
        Task { @MainActor in await self.show(nil, agent: nil) }
    }

    deinit { if let token { hub.off(token) } }

    var shown: String? { data?["current"]?.string }

    func show(_ id: String?, agent: String?) async {
        do { data = try await channels.benchmarkList(id, agent: agent) } catch { self.error = error.localizedDescription }
    }

    /// The notes waiting to be saved are saved now (a tab switched, or closed).
    public func flush() {
        for (slot, timer) in timers {
            timer.cancel()
            if let pair = (try? JSONValue.parse(slot))?.array, pair.count == 2 { _ = try? channels.benchmarkNote(pair[1].stringish, typed[slot] ?? "", pair[0].string) }
        }
        timers = [:]
    }

    public func setNote(_ key: String, _ text: String) {
        let run = shown
        let slot = JSONText.stringify([run.map { .string($0) } ?? .null, .string(key)])
        typed[slot] = text
        notes[key] = text
        timers[slot]?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated {
            guard let self else { return }
            self.timers[slot] = nil
            do { _ = try self.channels.benchmarkNote(key, text, run) } catch { self.error = error.localizedDescription }
        } }
        timers[slot] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.noteSaveMs, execute: work)
    }

    private func reset() { flush(); notes = [:]; error = ""; said = "" }

    public func pick(_ id: String) { guard id != shown else { return }; reset(); Task { @MainActor in await show(id, agent: nil) } }
    public func newRun() { reset(); Task { @MainActor in do { let id = try channels.benchmarkNew(); await show(id, agent: nil) } catch { self.error = error.localizedDescription } } }
    public func pickAgent(_ agent: String) { reset(); Task { @MainActor in await show(shown, agent: agent) } }
    public func run() { error = ""; Task { @MainActor in do { _ = try await channels.benchmarkRun(key: nil, shown) } catch { self.error = error.localizedDescription } } }
    public func stop() { do { _ = try channels.benchmarkStop() } catch { self.error = error.localizedDescription } }
    public func runOne(_ key: String) { error = ""; Task { @MainActor in do { _ = try await channels.benchmarkRun(key: key, shown) } catch { self.error = error.localizedDescription } } }

    public func export(answerHTML: @escaping (String) -> String = BenchmarkPage.plainAnswerHTML) {
        guard let data else { return }
        error = ""; said = ""
        let run = (data["runs"]?.array ?? []).first { $0["id"] == data["current"] }
        let page = BenchmarkPage.html(data, notes: notes, answerHTML: answerHTML)
        let name = "\(BenchmarkPage.agentName(data).lowercased())-benchmark-\(run?["id"]?.stringish ?? "answers")-\(String(Time.iso().prefix(10)))"
        Task { @MainActor in
            do { let saved = try await channels.export(page, name: name); said = saved.map { "Saved \($0)" } ?? "Not saved." } catch { self.error = error.localizedDescription }
        }
    }
}

public struct BenchmarkView: View {
    @ObservedObject var model: BenchmarkModel
    /// The document's reading of an answer, as an attributed string (the Doc package's); nil draws the plain reading.
    let answer: ((String) -> AttributedString)?
    let answerHTML: (String) -> String

    public init(model: BenchmarkModel, answer: ((String) -> AttributedString)? = nil, answerHTML: @escaping (String) -> String = BenchmarkPage.plainAnswerHTML) {
        self.model = model; self.answer = answer; self.answerHTML = answerHTML
    }

    public var body: some View {
        let data = model.data
        let groups = data?["groups"]?.array ?? []
        let runs = data?["runs"]?.array ?? []
        let agents = data?["agents"]?.array ?? []
        let live = data == nil || data?["live"] != false
        let running = data?["running"]?.truthy ?? false
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !agents.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(Array(agents.enumerated()), id: \.offset) { _, agent in
                            runTab(agent["name"]?.stringish ?? "", on: agent["id"] == data?["agent"]) { model.pickAgent(agent["id"]?.stringish ?? "bart") }
                                .disabled(running && agent["id"] != data?["agent"])
                        }
                    }
                    .padding(.bottom, 8)
                }
                if !runs.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(Array(runs.enumerated()), id: \.offset) { _, run in
                            let when = BenchmarkPage.runWhen(run["at"]?.string)
                            runTab("\(run["name"]?.stringish ?? "")\(when.isEmpty ? "" : " · \(when)")", on: run["id"] == data?["current"]) { model.pick(run["id"]?.stringish ?? "") }.help(when)
                        }
                        Button("+ New run") { model.newRun() }.buttonStyle(.plain).foregroundStyle(Color(NSColor(hex: "#0050c0"))).underline().disabled(running)
                    }
                    .padding(.bottom, 6).frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottom) { AM.rule.frame(height: 1) }
                    .padding(.bottom, 10)
                }
                HStack(spacing: 12) {
                    if running { plainButton("Stop") { model.stop() } }
                    else if live { plainButton("Run") { model.run() }.disabled(groups.isEmpty) }
                    else { Text("Kept as it was answered.").foregroundStyle(AM.dim) }
                    plainButton("Export") { model.export(answerHTML: answerHTML) }.disabled(groups.isEmpty)
                    if !model.said.isEmpty { Text(model.said).foregroundStyle(AM.dim) }
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(AM.error) }
                }
                .padding(.bottom, 8)
                if data == nil { Text("Loading…").foregroundStyle(AM.dim) }
                else if groups.isEmpty { Text("No \(BenchmarkPage.agentName(data)) questions in the notes.").foregroundStyle(AM.dim) }
                else {
                    ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                        Text(group["name"]?.stringish ?? "").font(AM.bold).padding(.top, 14).padding(.bottom, 4)
                        ForEach(Array((group["entries"]?.array ?? []).enumerated()), id: \.offset) { _, entry in entryView(entry, live: live) }
                    }
                }
            }
            .padding(EdgeInsets(top: 8, leading: 14, bottom: 40, trailing: 14))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onDisappear { model.flush() }
    }

    private func runTab(_ title: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).foregroundStyle(on ? Color.white : AM.ink).padding(.vertical, 1).padding(.horizontal, 8)
                .background(on ? AM.ink : Color.white).overlay(Rectangle().stroke(AM.rule, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    @ViewBuilder private func entryView(_ entry: JSONValue, live: Bool) -> some View {
        let key = entry["key"]?.stringish ?? ""
        let new = entry["new"]
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(entry["question"]?.stringish ?? "").font(AM.bold).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                if live {
                    Button("Run again") { model.runOne(key) }.buttonStyle(.plain).foregroundStyle(Color(NSColor(hex: "#0050c0"))).underline().disabled(new?["running"]?.truthy ?? false)
                }
            }
            .padding(.bottom, 6)
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) { Text("Old").foregroundStyle(AM.dim); answerBox(entry["old"]?.stringish ?? "") }.frame(maxWidth: .infinity, alignment: .topLeading)
                VStack(alignment: .leading, spacing: 2) {
                    Text("New").foregroundStyle(AM.dim)
                    if new?["running"]?.truthy ?? false { Text("Running…").foregroundStyle(AM.dim) }
                    else if let answer = new?["answer"]?.string { answerBox(answer) }
                    else if let error = new?["error"]?.string { Text(error).foregroundStyle(AM.error) }
                }.frame(maxWidth: .infinity, alignment: .topLeading)
            }
            TextEditor(text: Binding(get: { model.notes[key] ?? entry["note"]?.stringish ?? "" }, set: { model.setNote(key, $0) }))
                .font(AM.font).frame(minHeight: 44).padding(4).overlay(Rectangle().stroke(AM.rule, lineWidth: 1)).padding(.top, 6)
        }
        .padding(.top, 8).padding(.bottom, 10)
        .overlay(alignment: .top) { AM.rule.frame(height: 1) }
    }

    /// An answer in its grey box (14/1.6 sans, #4d4d4d on #fafafa, a 2px #dcdcdc rule on the left).
    @ViewBuilder private func answerBox(_ text: String) -> some View {
        Group {
            if let answer { Text(answer(text)) } else { Text(text) }
        }
        .font(Fonts.swiftUISans(14)).foregroundStyle(Color(Palette.mut)).lineSpacing(14 * 0.6 - 4).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 6).padding(.horizontal, 12)
        .background(Color(Palette.gray50))
        .overlay(alignment: .leading) { Color(NSColor(hex: "#dcdcdc")).frame(width: 2) }
    }
}
