import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// session.cjs's pure helpers (connect-options.test.cjs, connect-shown-name.test.cjs and the direct-run shapes of
/// connect.test.cjs): options and their detail, the prompt's rules, the project and period blocks, Import your context's
/// answer made safe, what the librarian is told and what the chat shows, the opener's sign-in lines.
final class SessionModelTests: XCTestCase {
    func testOptionOfAndDetail() {
        let detail = "Research Chat 1 · 2026-09-14 · Drive / Research\r\nResearch Chat 2 · 2026-09-21 · Drive / Research\n\n  Research   Chat 3 · 2026-09-28  \nand 4 more"
        XCTAssertEqual(SessionText.optionOf(["label": "All the Research Chat docs", "why": "7 docs", "detail": .string(detail)]),
                       ["label": "All the Research Chat docs", "why": "7 docs", "detail": "Research Chat 1 · 2026-09-14 · Drive / Research\nResearch Chat 2 · 2026-09-21 · Drive / Research\nResearch Chat 3 · 2026-09-28\nand 4 more"])
        let twelve = (1...12).map { "Meeting \($0) · 2026-0\((($0 - 1) % 9) + 1)-01" }.joined(separator: "\n")
        let ten = JS.string(SessionText.optionOf(["label": "Meetings", "detail": .string(twelve)])?["detail"])
        XCTAssertEqual(ten.components(separatedBy: "\n").count, 10)
        XCTAssertTrue(JS.test(ten, #"Meeting 10 · [^\n]*$"#))
        let long = JS.string(SessionText.optionOf(["label": "Long", "detail": .string(String(repeating: "x", count: 900))])?["detail"])
        XCTAssertEqual(long.count, 600); XCTAssertTrue(long.hasSuffix("…"))
        for value: JSONValue in [.null, 42, ["a", "b"], ["text": "a"], true] { XCTAssertEqual(SessionText.optionOf(["label": "A", "detail": value])?["detail"]?.string, "") }
        XCTAssertEqual(SessionText.optionOf("Just a label"), ["label": "Just a label", "why": "", "detail": ""])
        XCTAssertEqual(SessionText.optionOf(["label": "Thesis draft", "ids": ["1abcDEF_ghij", "1abcDEF_ghij", 7, ""]], multi: true)?["ids"], ["1abcDEF_ghij"])
        XCTAssertEqual(SessionText.optionOf(["label": "Research", "why": "48 notes", "checked": true], multi: true), ["label": "Research", "why": "48 notes", "detail": "", "checked": true])
        for value: JSONValue in [.null, "yes", 1] { XCTAssertEqual(SessionText.optionOf(["label": "Daily", "checked": value], multi: true)?["checked"], false) }
        XCTAssertNil(SessionText.optionOf(["label": "Code only", "checked": true])?["checked"])
        XCTAssertNil(SessionText.optionOf(["label": "  "]))
        let choices = SessionText.cleanChoices(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]]], homeDir: "/tmp/h")
        let multi = SessionText.readReply(#"{"ask":{"source":"notes","kind":"multi","title":"Which folders?","options":[{"label":"Research","checked":true},{"label":"Essays","checked":true},{"label":"Daily","checked":false}]}}"#, choices: choices)
        XCTAssertEqual(multi["ask"]?["options"]?.array?.map { $0["checked"] }, [true, true, false])
        let single = SessionText.readReply(#"{"ask":{"source":"notes","kind":"single","title":"Which account?","options":[{"label":"a","checked":true}]}}"#, choices: choices)
        XCTAssertTrue((single["ask"]?["options"]?.array ?? []).allSatisfy { $0["checked"] == nil })
        let code = SessionText.cleanChoices(["sources": ["code": ["on": true]]], homeDir: "/tmp")
        XCTAssertEqual(SessionText.readReply(#"{"say":"","ask":{"source":"code","kind":"repos","title":"Which repositories?"}}"#, choices: code)["ask"],
                       ["source": "code", "kind": "repos", "title": "Which repositories?", "options": [], "placeholder": ""])
        XCTAssertEqual(SessionText.readReply(#"{"ask":{"source":"code","kind":"multi","title":"Which repositories should come in?","options":["a/b","c/d"]}}"#, choices: code)["ask"]?["kind"]?.string, "repos")
        XCTAssertEqual(SessionText.readReply(#"{"ask":{"source":"code","kind":"single","title":"Notebooks and data too, or only the code?","options":["Code only","Everything"]}}"#, choices: code)["ask"]?["kind"]?.string, "single")
    }

    func testPromptRules() {
        let prompt = Texts.interviewSystemPrompt
        XCTAssertTrue(prompt.contains(#""ids": ["<Google Drive and Overleaf: the survey ids it stands for>"]"#))
        let rule = prompt.components(separatedBy: "\n").first { $0.hasPrefix("- Fill an option's \"detail\"") } ?? ""
        for part in ["from <found> only, never invent", "more than one thing", "date and where it is", "up to about 8, then \"and N more\"", "Leave \"detail\" out when the label says it all"] { XCTAssertTrue(rule.contains(part), part) }
        let prefer = prompt.components(separatedBy: "\n").first { $0.hasPrefix("- Prefer options") } ?? ""
        XCTAssertTrue(prefer.contains("\"multi\" (pick any) is the default"))
        XCTAssertTrue(prompt.contains("'Google Docs' in <choices> and <found> is the person's Google Drive: Docs, Sheets, Slides and uploaded files. Call it Google Drive."))
        XCTAssertFalse(prompt.contains("multiple choice"))
        XCTAssertEqual(ConnectSources.shownName("Google Docs"), "Google Drive")
        for app in ["Obsidian", "Notion", "Google Meet", "ChatGPT", "GitHub", "Something new"] { XCTAssertEqual(ConnectSources.shownName(app), app) }
        XCTAssertTrue(Texts.skills["Google Docs"]?.hasPrefix("# Google Drive and Docs") == true)
        // A prompt of the person's own in <dataRoot>/.context replaces the built-in one; empty, the built-in stays.
        let root = TempDir()
        XCTAssertEqual(SessionText.promptOf(root.path, "connect-system-prompt.md", "BUILT"), "BUILT")
        root.write(".context/connect-system-prompt.md", "  MINE  \n")
        XCTAssertEqual(SessionText.promptOf(root.path, "connect-system-prompt.md", "BUILT"), "MINE")
        root.write(".context/connect-system-prompt.md", "   ")
        XCTAssertEqual(SessionText.promptOf(root.path, "connect-system-prompt.md", "BUILT"), "BUILT")
    }

    func testProjectAndPeriodBlocks() {
        XCTAssertNil(SessionText.cleanProject(["name": "  ", "description": ""]))
        XCTAssertNil(SessionText.cleanProject("x"))
        let p = SessionText.cleanProject(["name": .string(String(repeating: "n", count: 300)), "description": " d "])
        XCTAssertEqual(p?.name.count, 200); XCTAssertEqual(p?.description, "d")
        let withProject = SessionText.cleanChoices(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]], "project": ["name": "Study", "description": "Help-seeking."]], homeDir: "/tmp")
        XCTAssertEqual(SessionText.projectBlock(withProject), "<project note=\"What the person is working on: the project this library is being connected for.\">\nName: Study\nDescription: Help-seeking.\n</project>")
        let nameOnly = SessionText.cleanChoices(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]], "project": ["name": "Study"]], homeDir: "/tmp")
        XCTAssertEqual(SessionText.projectBlock(nameOnly), "", "only a project with a description is told")
        XCTAssertEqual(SessionText.periodBlock(nameOnly), "<period days=\"all\">All time: no limit on how far back.</period>")
        // Only 182 and 365 are periods; anything else is all time.
        let month = SessionText.cleanChoices(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]], "days": 30], homeDir: "/tmp")
        XCTAssertEqual(SessionText.periodBlock(month), "<period days=\"all\">All time: no limit on how far back.</period>")
        let year = SessionText.cleanChoices(["sources": ["notes": ["on": true, "apps": ["Obsidian"]]], "days": 365], homeDir: "/tmp")
        XCTAssertTrue(SessionText.periodBlock(year).hasPrefix("<period days=\"365\">Only the past year: things changed or written in the last 365 days."))
    }

    func testDirectAnswerMadeSafe() {
        let home = TempDir()
        home.mkdir("Vault"); home.mkdir("Papers")
        let input: JSONValue = ["direct": ["mode": "weird", "projects": [["title": "A study", "description": "About help."], ["title": "  "], ["id": "x1", "title": "B", "folder": "/etc"]],
                                           "roles": ["Researcher", "Nobody"], "work": "  I   study  ", "apps": ["Obsidian", "Obsidian", "Not a tool", .string(ConnectSources.localPDFs), .string(ImportFlow.sites), .string(ImportFlow.localFolders)],
                                           "scopes": .object(["Obsidian": ["folders": [["path": "~/Vault"], "/etc", "~/../x"], "note": "Only research.", "people": ["Ana"]],
                                                      ConnectSources.localPDFs: ["folders": ["~/Papers"]], ImportFlow.localFolders: ["folders": ["~/Vault"]]]),
                                           "additional": [["name": "Linear", "website": "https://www.linear.app/team", "note": "Issues.", "projects": ["A study"]], ["name": ""], ["name": "Figma", "website": "ftp://x"]]]]
        let d = SessionText.cleanDirect(input["direct"], homeDir: home.path)!
        XCTAssertEqual(d.mode, "auto")
        XCTAssertEqual(d.projects.map(\.id), ["project-1", "x1"]); XCTAssertEqual(d.projects[1].folder, "", "a folder outside home is dropped")
        XCTAssertEqual(d.roles, ["Researcher"]); XCTAssertEqual(d.work, "I study")
        XCTAssertEqual(d.apps, ["Obsidian", ConnectSources.localPDFs, ImportFlow.sites, ImportFlow.localFolders])
        XCTAssertEqual(d.scopes["Obsidian"]?.folders.compactMap(\.path), [home.url.appendingPathComponent("Vault").path])
        XCTAssertEqual(d.additional.map(\.name), ["Linear", "Figma"]); XCTAssertEqual(d.additional[1].website, "", "not a web address")
        XCTAssertEqual(SessionText.toolSaid(d.additional[0]), "Linear (https://www.linear.app/team): Issues; only for these of the projects: A study")
        XCTAssertEqual(SessionText.toolSaid(d.additional[1]), "Figma")
        let notes = SessionText.librarianNotes(d)
        XCTAssertTrue(notes.contains("They describe their work as: Researcher."))
        XCTAssertTrue(notes.contains("- Obsidian: Only research; only these folders and files: \(home.url.appendingPathComponent("Vault").path); only with these people: Ana"), notes)
        XCTAssertTrue(notes.contains("Other tools they use that Engelbart has no source for:\n- Linear"))
        let o = SessionText.directInput(input, homeDir: home.path)
        XCTAssertEqual(o["sources"]?["notes"]?["apps"], ["Obsidian"])
        XCTAssertEqual(o["sources"]?["sites"]?["on"], true)
        XCTAssertEqual(o["sources"]?["code"]?["folders"], [.string(home.url.appendingPathComponent("Vault").path)])
        XCTAssertEqual(o["sources"]?["papers"]?["folders"], [.string(home.url.appendingPathComponent("Papers").path)])
        XCTAssertEqual(o["project"]?["name"]?.string, "A study, B")
        XCTAssertEqual(o["project"]?["description"]?.string, "A study: About help.\nB")
        XCTAssertNil(SessionText.cleanDirect(["apps": ["Not a tool"]], homeDir: home.path), "nothing to bring in")
        XCTAssertEqual(SessionText.directInput(["sources": [:]], homeDir: home.path), ["sources": [:]], "no direct: as given")
    }

    func testWhatTheLibrarianIsToldAndTheChatShows() {
        XCTAssertEqual(SessionText.messageOf(["skipped": true]), "skipped")
        XCTAssertEqual(SessionText.messageOf(["skipped": true, "left": "Gmail"]), "skipped: Gmail is left out for this run; nothing of it comes in")
        XCTAssertEqual(SessionText.messageOf(["importNow": true]), "Import now.")
        XCTAssertEqual(SessionText.messageOf(["picked": ["Everything"], "text": "but not Personal"]), #"picked "Everything", and said: but not Personal"#)
        XCTAssertEqual(SessionText.messageOf(["authorized": ["app": "Apple Notes", "kind": "permission"]]), #"allowed "Apple Notes""#)
        XCTAssertEqual(SessionText.messageOf(["authorized": ["app": "Zotero", "kind": "signin"]]), #"signed in "Zotero""#)
        XCTAssertEqual(SessionText.messageOf(["chose": ["kind": "folder", "shown": "~/Vault", "app": "Obsidian"]]), #"chose folder "~/Vault" for "Obsidian""#)
        XCTAssertEqual(SessionText.messageOf(["survey": "Gmail"]), #"survey finished: "Gmail""#)
        XCTAssertEqual(SessionText.messageOf(["text": "  hello\n there "]), "hello there")
        XCTAssertEqual(SessionText.shownOf(["skipped": true]), "Skip")
        XCTAssertEqual(SessionText.shownOf(["importNow": true]), "Import now")
        XCTAssertEqual(SessionText.shownOf(["authorized": ["app": "Google Docs", "kind": "signin"]]), "Signed in to Google Drive")
        XCTAssertEqual(SessionText.shownOf(["authorized": ["app": "Apple Notes", "kind": "permission"]]), "Allowed Apple Notes")
        XCTAssertEqual(SessionText.shownOf(["chose": ["shown": "~/Vault"]]), "~/Vault")
        XCTAssertEqual(SessionText.listed(["ChatGPT"]), "ChatGPT")
        XCTAssertEqual(SessionText.listed(["ChatGPT", "Claude", "Gemini"]), "ChatGPT, Claude and Gemini")
        XCTAssertEqual(SessionText.skippedLine("Chrome", ["ChatGPT", "Google Docs"]), "Skipped ChatGPT and Google Drive: macOS didn't allow Chrome's sign-ins. You can add them later from Add sources.")
        XCTAssertEqual(SessionText.leftOutLine(["Google Docs"]), "Left out Google Drive: not signed in. You can add it from Add sources.")
        XCTAssertEqual(SessionText.signInLines(signedIn: [("ChatGPT", "Chrome"), ("Claude", "Chrome"), ("Gmail", "")], refused: [("Gemini", "Brave")]),
                       "Using your Chrome sign-ins for ChatGPT and Claude.\nSkipped Gemini: macOS didn't allow Brave's sign-ins. You can add it later from Add sources.")
    }

    func testModelsPinned() {
        let a = ConnectModels.choice("anthropic", models: nil), o = ConnectModels.choice("openai", models: nil)
        XCTAssertEqual([a.modelName, a.effort, o.modelName, o.effort], ["Sonnet", "high", "Sol", "high"])
        XCTAssertEqual(ConnectModels.choice("nobody", models: nil).provider, "anthropic")
        let listed = ConnectModels.choice("openai", models: ["providers": ["openai": ["models": .object([o.model: ["id": "gpt-x-sol", "name": "Sol X"]])]]])
        XCTAssertEqual(listed.modelId, "gpt-x-sol"); XCTAssertEqual(listed.modelName, "Sol X")
    }
}
