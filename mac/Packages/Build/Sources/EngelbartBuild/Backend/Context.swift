import Foundation
import EngelbartCore

/// What a Build is given (context.cjs, 2026-09-25 B6): the first message, frozen into context.md when Build is pressed, so
/// notes edited afterwards never reach a Build already running. It is @bart's context — the workspace document with every
/// mention in place, and the library as Context.json — plus what the panel attached, the newest archived version of the
/// workspace marked as history, and where the Build works. A post-it added to a workspace (2026-09-27) is a Build of that
/// workspace whose task is the post-it; a request typed on an @bart line after --build (2026-10-02) is given as <request>
/// with the notes it mentions, and without the workspace's history.
public enum BuildContext {
    public static let buildLinePattern = "^build> [a-z0-9]{6,32}$"

    static func isBuildLine(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).range(of: buildLinePattern, options: .regularExpression) != nil
    }

    static func attr(_ value: String) -> String {
        String(value.replacingOccurrences(of: #"[<>"\n\r]"#, with: " ", options: .regularExpression).prefix(200))
    }

    /// A document's text with its mentions in place and its Build lines (drawn cards, not words) left out.
    static func expandText(_ text: String, host: BuildHost, projectId: String, rows: [LibraryRow], seen: MentionSeen) async -> String {
        let plain = text.components(separatedBy: "\n").filter { !isBuildLine($0) }.joined(separator: "\n")
        let expanded = await host.expandMentions(plain, projectId: projectId, rows: rows, seen: seen)
        return expanded.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) // trimEnd
    }

    /// The frozen first message. `task` carries where the Build works; `attach` library ids; `postIt` the post-it's text
    /// (a quick task's, or one added to the workspace); with `fromLine`, the request typed on a line of the workspace.
    static func freeze(host: BuildHost, projectId: String, task: TaskRecord, workspaceId: String?, attach: [String],
                       postIt: String?, fromLine: Bool) async throws -> (text: String, archive: String?) {
        let project = try host.project(projectId)
        let rows = await host.libraryRows()
        let seen = MentionSeen()
        var parts: [String] = []
        var history: BuildArchive?
        var from = "a post-it"
        var blocks: [String] = []
        let fromPostIt = postIt != nil
        let request = fromPostIt && fromLine && workspaceId != nil
        let trimmedPostIt = (postIt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if fromPostIt && !request { blocks.append("<post-it>\n\(trimmedPostIt)\n</post-it>") }
        if let workspaceId {
            let workspace = try host.workspace(projectId, workspaceId)
            seen.insert("ws:\(workspaceId)")
            if request {
                blocks.append("<request>\n\(await expandText(trimmedPostIt, host: host, projectId: projectId, rows: rows, seen: seen))\n</request>")
                from = "a request typed on a line of the workspace \"\(workspace.name)\""
            } else if fromPostIt {
                from = "a post-it added to the workspace \"\(workspace.name)\""
            } else {
                let text = (try? await host.readWorkspaceDoc(projectId, workspaceId)) ?? ""
                blocks.append("<workspace name=\"\(attr(workspace.name))\">\n\(await expandText(text, host: host, projectId: projectId, rows: rows, seen: seen))\n</workspace>")
                from = "the workspace \"\(workspace.name)\""
            }
            if !request { history = host.latestArchive(projectId, workspaceId) }
        }
        let extra = rows.filter { attach.contains($0.id) && !seen.contains($0.id) && $0.type != "image" }
        if !extra.isEmpty {
            blocks.append("<attached>\n\(await host.expandRows(extra, projectId: projectId, allRows: rows, seen: seen))\n</attached>")
        }
        if let history {
            let cleared = attr(history.clearedAt ?? history.file)
            blocks.append("<history cleared=\"\(cleared)\" note=\"An earlier version of this workspace, cleared by the person. Context only: do not implement anything that appears only here.\">\n\(await expandText(history.text, host: host, projectId: projectId, rows: rows, seen: seen))\n</history>")
        }
        var head = ["<engelbart>", "project: \(project.name)"]
        if let description = project.description, !description.isEmpty {
            head.append("project description: \(description.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression))")
        }
        let base = String((task.str("baseSha") ?? "").prefix(12))
        head += [
            "your working copy (make every change to the code here): \(task.str("worktree") ?? "")",
            "branch: \(task.str("branch") ?? ""), started from \(task.str("baseBranch").flatMap { $0.isEmpty ? nil : $0 } ?? "a detached commit") at \(base)",
            "the person's own folder (do not touch): \(task.str("repo") ?? "")",
            "notes and workspaces (you may write here; the engelbart tools add to the library): \(project.dir)",
            "built from: \(from)",
            "</engelbart>",
        ]
        parts.append(head.joined(separator: "\n"))
        if let instructions = host.instructionsBlock(), !instructions.isEmpty { parts.append(instructions) }
        if let page = host.projectPageBlock(projectId), !page.isEmpty { parts.append(page) } // the project page (2026-10-13)
        if let remembered = host.memoryBlock(), !remembered.isEmpty { parts.append(remembered) } // MEMORY.md (2026-10-07)
        parts.append(request
            ? "<task>\nDo what the request below asks. The person typed it on a line of a workspace as a full Build: larger changes are fine, and you may ask with NEEDS YOU when a choice is theirs. Notes it mentions are included under it; the rest of the workspace is not.\n</task>"
            : !fromPostIt
                ? "<task>\nDo what the workspace document below asks: it is the person's plan for this Build, usually ending with what to build now. Where it discusses options, follow what it settles on; where something it asks for is still undecided, choose sensibly and say what you chose, or ask with NEEDS YOU when the choice is theirs.\n</task>"
                : workspaceId != nil
                    ? "<task>\nDo what the post-it below asks. The person added it to a workspace as a full Build: larger changes are fine, and you may ask with NEEDS YOU when a choice is theirs.\n</task>"
                    : "<task>\nDo what the post-it below asks. It is a quick task: a small change, made without questions.\n</task>")
        parts += blocks
        parts.append("<context_json>\n\(host.catalogJSON(projectId: projectId, rows: rows, seen: seen))\n</context_json>")
        return (parts.joined(separator: "\n\n"), history?.file)
    }

    /// A reply of the person's, as the next message of the session. `images`: what they pasted ([n, path]).
    public static func replyMessage(_ text: String, images: [(n: Int, path: String)] = []) -> String {
        let reply = "<reply>\n\(text.trimmingCharacters(in: .whitespacesAndNewlines))\n</reply>"
        if images.isEmpty { return reply }
        let listed = images.map { "[Attachment \($0.n)]: \($0.path)" }.joined(separator: "\n")
        return "\(reply)\n\n<attachments note=\"Images the person pasted into the reply, named where the reply says [Attachment n]. Open each file to see it.\">\n\(listed)\n</attachments>"
    }

    /// A session that will not resume: everything again, then what was said, then the new message.
    public static func freshMessage(_ context: String?, _ messages: [JSONValue], _ next: String) -> String {
        let said = messages.compactMap { m -> String? in
            let role = m["role"]?.string
            guard role == "agent" || role == "you" else { return nil }
            return "<turn role=\"\(role == "agent" ? "you (the agent)" : "the person")\">\n\(m["text"]?.string ?? "")\n</turn>"
        }
        let conversation = said.isEmpty ? "" : "<conversation note=\"Your earlier session could not be resumed. This is what was said in it; your work so far is committed in the working copy.\">\n\(said.joined(separator: "\n"))\n</conversation>"
        return [context ?? "", conversation, next].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// A first message split into its top-level blocks, for the Agent map: `{ engelbart, task, workspace | request |
    /// post-it, attached, history, context_json, … }` in the order sent; text outside any block under `other`.
    public static func parts(_ text: String) -> [(String, String)] {
        let source = text as NSString
        var out: [(String, String)] = []
        func add(_ name: String, _ block: String) {
            if let i = out.firstIndex(where: { $0.0 == name }) { out[i].1 += "\n\n" + block } else { out.append((name, block)) }
        }
        let open = try! NSRegularExpression(pattern: #"^<([a-z][\w-]*)(?:\s[^>\n]*)?>"#, options: .anchorsMatchLines)
        var at = 0
        var other = ""
        var search = 0
        while search <= source.length, let m = open.firstMatch(in: text, range: NSRange(location: search, length: source.length - search)) {
            if m.range.location < at { search = m.range.location + 1; continue }
            let name = source.substring(with: m.range(at: 1))
            let close = source.range(of: "\n</\(name)>", range: NSRange(location: m.range.location, length: source.length - m.range.location))
            let end = close.location == NSNotFound ? source.length : close.location + (name as NSString).length + 4
            other += source.substring(with: NSRange(location: at, length: m.range.location - at))
            add(name, source.substring(with: NSRange(location: m.range.location, length: end - m.range.location)))
            at = end
            search = end
        }
        other += source.substring(from: at)
        let trimmed = other.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { out.append(("other", trimmed)) }
        return out
    }

    static func partsJSON(_ text: String) -> JSONValue {
        .object(Dictionary(parts(text).map { ($0.0, JSONValue.string($0.1)) }, uniquingKeysWith: { a, _ in a }))
    }
}
