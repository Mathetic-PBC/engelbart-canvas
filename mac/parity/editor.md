# Parity ledger: Editor (EngelbartEditor)

`src/renderer/workspace/DocEditor.jsx` (5179 lines) and MentionMenu, BartPicker, DocFind, Popover, caret.js,
ImageViewer, MadePeek, AgentChoice; ui/DocPreview, FindCard, InlineField, ThinkingDots. The editor is an NSTextView
(TextKit 1). Its pure core (`EditorCore`: lines, caret, undo, keys, typing, paste, mentions) is tested without AppKit;
the view (`DocEditorView`) draws lines and cards and talks to the outside only through `DocEditorHost`.

Status rule: `done` = covered by EditorPackageTests, which passed in the cloud (GitHub Actions run 40753862574,
2026-10-28, 41 tests: EditorCoreTests and RendererTests); "compiled, untested" = built, no test reaches it yet.

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | props.text is the source of truth; every edit hands the whole text to the host synchronously (onChange) | DocEditor.jsx:4 setDoc | EditorCore.setDoc → host.save | done |
| 2 | Undo history: each change pushes {text, caret anchor}; max 200; redo cleared on change; ⌘Z/⇧⌘Z | setDoc/undo/redo :1166 | EditorCore | done |
| 3 | Undo restores the caret the step was taken at | undo :1181 | EditorCore | compiled, untested |
| 4 | Active line shows its source tokens; every other line renders; tokens with markup open only when the caret touches them (`a<=end && b>=start`); mentions only strictly inside; attachments never; heading `# ` shown on the active line | openIdx/activeHtml :1206 | LineRenderer | done |
| 5 | An answer line the mouse put the caret on keeps its links and [[build]] drawn (linksShut/byMouse) | linksShut :1213 | — | partial: the shut rule exists in the renderer but answer lines are never the caret's line (read-only since 2026-10-16), so it is not wired |
| 6 | @bart line flags readQuestion/discoverSpans recognises are their own tokens drawn weight 500; @brainstorm reads none | bartTokens :1230 | LineRenderer | compiled, untested |
| 7 | A sent question (answered or pending) not being edited is drawn without its flags and says `@bart` whatever its agent | unflaggedHtml :1241, :1317 | LineRenderer | done |
| 8 | Typing at the edge of a closed token (right before/after a mention) is the line's own text beside it | segs :1251 | EditorCore segment map | compiled, untested |
| 9 | displayToRaw/rawToDisplay through segments (units before/after; mention end = source end) | :1264 | Segments.swift | done |
| 10 | Todo row: 16×16 box radius 4, border 1.5 #c9c9c9 / filled #0070f3 with white check when done; text grey #8f8f8f + line-through when done; indent depth×24px; gap 10; min-height 35 | lineHtml :1291 | LineRenderer | done |
| 11 | Click on a todo's box toggles done (data-act toggle) | :1295 | DocEditorView | compiled, untested |
| 12 | Bullet row: `•` (#8f8f8f, 14px column, centred) or the number (right-aligned, tabular) ; indent depth×24; min-height 35 | :1299 | LineRenderer | done |
| 13 | Headings 26/22/18px weight 500, line-height 1.6, letter-spacing -0.3; padding 4px 0, or 12px top right under a card | :1307 | LineRenderer | done |
| 14 | Paragraph: padding 4px 0, min-height 35 | :1495 | LineRenderer | compiled, untested |
| 15 | Quote: grey #fafafa block, left rule 2px #dcdcdc, text #4d4d4d, consecutive quotes one block; active shows faint `> ` (#b5b5b5); editable since 2026-10-16 | :1477 | LineRenderer | done |
| 16 | Image line: picture (max-height 520, border 1px #eaeaea radius 8), width from alt `name|w=320`; `img:` src from host images; missing → dashed placeholder `name…`; active keeps the picture with caret before/after | :1484 | ImageLine | done |
| 17 | Image corners resize (16px invisible squares, nwse/nesw cursors), width kept in alt `|w=` | IMG_CORNERS :506 | ImageLine | partial: width written by EditorCore.resizeImage (tested); no corner handles in the view yet |
| 18 | Image drag to another line gap (not inside a conversation or a code block) moves the line (imgDropGaps, moveLineTo) | :510 | EditorCore.imgDropGaps/moveLineTo | done |
| 19 | Code block: lines mono 14/1.7 on #fafafa; opening fence = head with language (12px #8f8f8f) + Copy; closing fence a strip radius 0 0 10 10; active fence shows source mono grey; code lines always show source, JSON coloured | codeHtml :1511 | LineRenderer | done |
| 20 | ```math block drawn as display math while the caret is outside; its body hidden; Copy copies the LaTeX; undrawable stays code | mathBlock :1505 | LineRenderer | done |
| 21 | Answer code blocks: white box inside the answer rule, language + Copy head, border #eaeaea, radius 8 | answerCodeHtml :1523 | AnswerCard | compiled, untested |
| 22 | Copy on a code block copies its body; button shows "Copied" briefly | copyCodeHtml :1539 | DocEditorView | compiled, untested |
| 23 | Lines locked from typing: build, title, reply (every answer line since 2026-10-16), collapsed conversation lines, a question with a pending/reply under it (unless being edited), pending | lockedAt :1062 | EditorCore.lockedAt | done |
| 24 | Document needs a free line after a card or code block (endsOnCard) | :1071 | EditorCore | done |
| 25 | Message box (unasked question): #fafafa, radius 10, padding 9 10 9 16, chip (model + effort label + chevron, 13px #4d4d4d) and round 28px send (blue #0070f3 when ready, #ececec otherwise); disabled when nothing to ask | :1333 :1358 | QuestionRow | done |
| 26 | Asked question row: card top, 16px font, #fafafa, Collapse corner when answered (first open turn collapses whole titled conversation) | :1362 | AnswerCard | compiled, untested |
| 27 | Pending row: "Thinking"/activity/"Thinking harder" + `· Model effort`, wave text; steps count toggle; Stop; Hide when no run (interrupted text "No answer came back: the run was interrupted."); stream box max min(240px,35vh) following newest line unless scrolled up 40px; streaming text grey 14px without citations/half links; code arriving mono | :1378 | PendingRow | partial: row drawn (deco tested); the stream box does not hold a scrolled-up position |
| 28 | Answer lines: #262626 16/1.65 in #fafafa card, left rule 2px #d6d6d6, read-only but selectable; folded lines hidden; foot drawn as the card foot | :1438 | AnswerCard | done |
| 29 | Research box / trace (Discover), brainstorm cards, recaps, result offer, Send to Discover, guide bookmarks, create rows | :1314 :1386 :1459 :1569 | — | partial: research head drawn; brainstorm cards, recaps, result offer, Send to Discover, guide bookmarks, create rows not ported (rows 97-99) |
| 30 | Scroll position per (viewScope, docKey) reported 300 ms after scrolling stops and when left; restored by first visible line + offset + FNV-1a hash of its text (nearest line with same hash) for 4 s while layout settles | captureView/applyView :890 | DocEditorView | compiled, untested |
| 31 | showLine(i, flash): centre line i; flash #fff1b8 for 2.4 s; expands a collapsed conversation first | showLine :952 | DocEditorView | compiled, untested |
| 32 | showPassage(i, find): centre and highlight the quoted words (matchPassage over ≤8 lines), cleared by next press/key; expands folded turn / Show more first | :982 | DocEditorView | compiled, untested |
| 33 | focusStart/focusEnd/isActive/shutMenus/caretNow/placeCaret public entry points | :806 | DocEditorView API | done for setDocument/setText (tested); the rest compiled, untested |
| 34 | Escape with picker/hover card/topic menu open shuts it only (marked used) | escapeShut :881 | DocEditorView | compiled, untested |
| 35 | Mentions of the document open in the pane beside are marked (#e8f0fe bg) | markBeside :848 | LineRenderer | compiled, untested |
| 36 | Zotero chip states: "· Finding a free copy…" while finding; waiting label "Download the PDF in your browser to open it in the Stage" under it; drop target highlight | markFinding :860 | — | partial: drop on a Zotero chip compiled; the finding/waiting labels are not drawn |
| 37 | Press in the space under a card (or the padding above a heading under a card) makes/places a line there (gapAt/openGap), one undo step | :1140 | EditorCore.gap | partial: EditorCore.openGap done; the view does not yet hit-test the gap under a card |
| 38 | A remote change (answer arriving) above the caret line keeps the caret on the same unchanged line (head/tail diff) | componentDidUpdate :754 | EditorCore.rebase | done |
| 39 | Progress (asks/builds) patches pending rows and build cards only; caret and selection untouched | :770 | DocEditorView.patchPending | compiled, untested |
| 40 | Switching docKey: history cleared, active line/menus closed, view restored | :743 | DocEditorView.setDocument | done |
| 41 | Focus leaving the editor (not to the @ menu) cancels edit mode and leaves the line; app switch does not | focusout :699 | DocEditorView | compiled, untested |
| 42 | IME composition: input applied at compositionend | :700 | DocEditorView (marked text) | compiled, untested |
| 43 | Never ends on a locked/card/fence line: a `\n` is appended; never starts on a locked line: `\n` prepended and caret/active line shifted down one | syncEditor :3136 | EditorCore.normalize | done |
| 44 | Typing into a row: the space that finishes a marker on an empty row is swallowed; a marker typed at the head re-types the row (retypedRow) only when the caret is right after it; caret moves back by the marker-length difference; canonicalLine stored; code kept as typed | editorInput :3335 | EditorCore.typeOnLine | done |
| 45 | A bulk delete that empties a row leaves a plain empty line | :3358 | EditorCore | compiled, untested |
| 46 | A delete across lines keeps every locked line (answers, asked questions) unless its whole conversation (title..to) is inside the selection and not running | :3369 | EditorCore.deleteAcross | done |
| 47 | Typing beside a picture line makes a line of its own above/below it (besidePicture) | :3394 :3700 | EditorCore.besidePicture | done |
| 48 | Heading typed into before redraw keeps its `# `; quote keeps `> `; a fence drawn as its language keeps its backticks | :3350 | EditorCore | n/a: edits apply to the source text through the model, so no prefix can be lost by a redraw |
| 49 | No @ menu inside code | :3424 | EditorCore | compiled, untested |
| 50 | @ menu keys: ↓/↑ wrap, Enter/Tab pick, Escape closes; Backspace in a folder at its path goes up | editorKey :3460 | MentionController | compiled, untested |
| 51 | ⌘Z undo / ⇧⌘Z redo | :3468 | EditorCore | done |
| 52 | Question in edit mode: Enter asks again (commitEdit), ⇧Enter nothing, Escape puts it back, Backspace at 0 / Delete at end do nothing | :3471 | EditorCore.editing | done |
| 53 | ⌘B wraps selection in `**`, ⌘I in `*`, ⌘K makes `[sel](url)` with `link` when empty (caret/selection placed on the url) | wrap/link :5029 | EditorCore | done |
| 54 | ⌘Enter does nothing | :3479 | EditorCore | compiled, untested |
| 55 | Tab/⇧Tab on todo/list indents/outdents (2 spaces, depth 0..8); in code indents by two spaces / outdents | :3480 indent/indentCode | EditorCore | done |
| 56 | `@Note name` + Enter makes a note by that name and replaces the words with its mention (host noteVerb) | :3482 | EditorCore + host | done |
| 57 | Enter on an @bart/@chat/... line asks it (askInline) | :3483 | EditorCore.askInline | done |
| 58 | Enter at the end of a lone opening fence inserts `` and the closing fence, caret inside | :3487 | EditorCore | done |
| 59 | Enter in code keeps the indent, +2 after an opening bracket `[{(` | :3493 | EditorCore | done |
| 60 | Enter on an empty todo/list: nested → outdent; top level → plain empty line | :3498 | EditorCore | done |
| 61 | Enter splits a line; the new row continues the kind (todo unchecked, list number +1, reply stays reply) | :3502 | EditorCore | done |
| 62 | Picture line: Backspace after/Delete before removes the picture (empty line stays); Backspace before/Delete after removes an adjacent empty line or steps onto the line; a character typed goes on its own line | :3509 | EditorCore | done |
| 63 | Backspace right after a mention / Delete right before one removes the whole token (one undo) | :3522 | EditorCore | done |
| 64 | Backspace at start of a quote's text removes `> `; at start of a row removes the mark (nested → outdent); at line start merges with line above, steps over fences, removes an empty line after a locked line, arms then removes a whole conversation above (blockAt) | :3529 :3535 | EditorCore | done |
| 65 | Delete at line end merges the next line (not locked, not across fences) or arms/removes the conversation below | :3570 | EditorCore | done |
| 66 | Escape leaves the line (blur) | :3581 | DocEditorView | compiled, untested |
| 67 | Pasted/dropped image files (png/jpeg/gif/webp) saved by the host as `Attachment n` (n = count of `](img:` + 1); inline token `![Attachment n](img:id)` with spacing in todo/list/bart lines; else on its own line (replacing an empty line) followed by an empty line; on an answer: under its conversation | pasteImages :3586 | EditorCore.placeImage | done for placement (tested); host paste compiled, untested |
| 68 | Drop: Zotero chip takes a pdf; pictures placed where let go; other items to host.dropItems; sidebar rows write their mentions where let go (or in a follow-up field) and are reported as picked | editorDrop/libDrop :3617 | DocEditorView | compiled, untested |
| 69 | Paste: over an answer nothing; image files → pasteImages; own-lines clipboard type kept as is; else plain text through pdfText (not in code) and withLinks from the HTML (not when it has `](`, not in code); quotes: blank ends trimmed, every line a quote line (`>` for blank); several lines into an askable question line flattened to one; else split into lines continuing the line kind | editorPaste :3705 | EditorCore.paste | done |
| 70 | Copy/Cut: markdown (selectionMarkdown) as plain text, selectionHtml as HTML, own lines type when whole conversations are in it; cut deletes like Backspace | editorCopy :3758 | DocEditorView.copy | done for the markdown/HTML (tested); pasteboard writing compiled, untested |
| 71 | Image resize writes `![name|w=W](src)` on mouse up, width ≥48 and ≤ editor width | startResize :3771 | ImageLine | done for the line written (tested); live resize not in the view |
| 72 | Image drag: after 5px a 220×160 ghost follows, original greyed, a 2px #c9c9c9 drop bar with ring at the nearest allowed gap; pane autoscrolls 14px near edges (40px); Escape cancels | startImgDrag :3790 | ImageLine | todo: no drag ghost or drop bar in the view |
| 73 | Click on a picture opens the viewer (all pictures of the note, ←/→, Copy image, close returns focus to the picture) | openPicture :3862 | ImageViewer | partial: viewer shows one picture (no left/right between the note's pictures) |
| 74 | Click below the last line puts the caret at the end (or makes a line after a card) | docClickInternal :4109 | DocEditorView | compiled, untested |
| 75 | Click a link opens it through the host (⌘-click: new tab; @discover passage links carry the answer's sections) | :4006 | DocEditorView | compiled, untested |
| 76 | Click a mention: made file → Stage; Zotero → host; folder file → host; unknown address → open link; workspace → open beside (⌘: go to it); note → open beside (⌘: as tab); others → host open item; agents open nothing | :4014 | DocEditorView | compiled, untested |
| 77 | Hover a mention shows its card (Popover); hover a citation shows its card, which stays while the pointer is on it (200 ms grace) | editorOver :4047 | Popover | partial: mention and citation cards drawn; workspace peek and made-file peek not ported |
| 78 | A press within 4px of an answer's link is a press on it | nearLink :4074 | DocEditorView | compiled, untested |
| 79 | Copy buttons say "Copied" for 1.4 s | :3926 | DocEditorView | compiled, untested |
| 80 | askInline: line typed under a card's answer starts its own conversation (empty line above); pending `bart~> <askId>` under it; empty title line `bart# [agent at]` above a question that starts a conversation; host.ask({askId, text, turns, agent, place, name}); router lines go to routeLine | askInline :4121 | EditorCore.askInline | done |
| 81 | askId = base36(Date.now()) + '-' + 8 random base36 chars | newAskId :170 | EditorCore | done |
| 82 | routeLine: `@bart` line gets its pending line, rule (empty→brainstorm, --build, level flags→discover, answering Discover→discover) else the host's router; pending row names the fallback's first step meanwhile; handOff writes the pick on the title line (or a new title line, or rewrites an untitled line to `@<token>`), stops a refined search, asks; `--build` gets a build title; a spec ≥0.8 sure is built | routeLine/handOff :4210 | EditorAsk.swift | done |
| 83 | Deep research waits 5 s ("Searching in n s", Cancel); a deleted line asks nothing | waitResearch :4323 | EditorAsk.swift | compiled, untested |
| 84 | Research boxes: states ready/running/interrupted/stopped/failed/finished; Start research, Restart, Run again; level chip steers a running box; replies under a box refine (`@discover --refine`) or steer (`--steer words`) | :2407 :4302 | EditorAsk.swift, ResearchView | partial: head and status drawn simply (no "Added:" lines, no model in the status) |
| 85 | Regenerate opens the selector under its icon; its blue button asks again with what is marked (ranWith: the closing line's model/effort) | :3959 :4532 | Popups.swift openPicker(.regen) | compiled, untested |
| 86 | Edit mode: question editable, answer dimmed, Enter asks again (turns after it removed, runs stopped, one undo), unchanged Enter leaves, a changed agent/--build/empty waits; trackEdit follows it when lines move | :4565-4637 | EditorAsk.swift | done for Enter/Escape/undo (tested); the answer fading to .45 compiled, untested |
| 87 | Collapse: first exchange of a titled conversation collapses it whole, later ones fold alone; collapsed row = pointer + title (blue, 15px) + when; ⌥-click renames; running title grey | :2289 :4657 | EditorAsk.swift, TitleRowView | done |
| 88 | autoCollapse once per docKey; Build-answered conversations decided once their record loads | :4694 | EditorAsk.swift | done |
| 89 | Collapse all / Expand all words top right (12.5px grey), turns of titled ones opened by Expand all | :5164 :4724 | DocEditorView.placeOverlays, EditorAsk.foldAll | done |
| 90 | Delete turn (stops its run; last turn takes its title); Copy turn = question without flags + answer | :4816 :4826 | EditorAsk.swift | done |
| 91 | Follow-up: reply field always under the last answered turn (`@bart` lead with a router), Enter sends, ⇧Enter nothing, line breaks pasted become spaces; sent = `@bart <flags> text` routed, or `@<agent>` without router; named agent at the start is asked as is; two newest turns stay open, older fold (not in Discover conversations); pasted images `[Attachment n]` written as image tokens | sendFollow :4399 | EditorAsk.sendFollow, ReplyFieldView | partial: sending tested; image paste into the reply field not wired |
| 92 | The model selector: provider field (cycles when several), models left, efforts right (132 px), marks filled ink; a model alone keeps the effort in force else the ladder's pairing; written into the line as flags (`withChoice`), a trailing space when no question; Discover lines open Quick/Standard/Deep | BartPicker.jsx, pickModel/pickLevel | Popups.swift PickerView | partial: provider field cycles on click instead of opening a list |
| 93 | @ menu: opens on `@` + ≤30 chars (or names with spaces a row holds), 400×≤420 placed below/above/larger side, rows 32 tall with kind glyphs, keyboard row #f2f2f2, ↓/↑ wrap, Enter/Tab pick, Escape closes; verbs write `@Bart ` etc. with a space, mentions without; follow-up fields leave verbs out | MentionMenu.jsx, pickMention | Popups.swift | partial: library folder browsing (MATH-22) not drawn; rows come from host.mentionItems |
| 94 | Hover a mention: card 330 wide (kind small caps, name 14.5/500, summary, facts); citation card 280 wide stays 200 ms for the pointer | Popover.jsx, cite.js | Popups.swift HoverCardView | partial: workspace peek and made-file peek not ported |
| 95 | Find (⌘F): card top-right ≤360×34, "n of m" / red "0 matches", ↑ ↓ ×, Enter/⇧Enter/↓/↑ step, Escape closes and puts the caret on the match in front; matches tinted rgba(0,112,243,.16), current .4; never across lines | FindCard.jsx, DocFind.jsx | Popups.swift FindBarView | compiled, untested |
| 96 | Picture viewer: large over the window, Escape/click closes, ⌘C copies | ImageViewer.jsx | Popups.swift ImageViewer | partial: no left/right between pictures |
| 97 | Brainstorm/Discover cards (older documents): choices, select-all ticks, Submit, repick with confirm, Skip, Wrap up, recaps as sections, result offer line, Send to Discover | :2153-2280 :1547-1580 | — | todo: needs main/bart/card.cjs (Bart) |
| 98 | @discover guide bookmarks (save/unsave paper, Save all (n)) | :1581-1635 | — | todo |
| 99 | @create rows (made files: icon, name, Save/Saved, inline frame, peek, running "Creating a …" row with m:ss and Stop), madeToOpen, makingLabel, creatingLine, createDoing | :375-470 :2859-2973 | — | todo |
| 100 | Answers longer than 6 lines cut with a fade and Show more/Show less (not the first or the latest answer) | applyClips :2995 | — | todo |
| 101 | Sources list under an answer that cites (numbers + names) | citeSourcesHtml :1761 | — | todo (Doc.Cite.citationSources ready) |
| 102 | Build card for `build> <id>` lines: the host's view, height from its fitting size | buildHtml :1773 | DocEditorView (.build) | partial: the host's view embedded; part patching is the Build package's |
| 103 | Image resize by corners and drag to another gap (ghost, drop bar) | :3771 :3790 | EditorCore.resizeImage/moveImage | partial: model done (tested); no corner handles or drag ghost |
| 104 | Streaming answer box follows the newest line unless scrolled up 40px; patched in place without moving the caret; ESCALATE never previewed (main strips it) | :3085 :3060 | PendingView | partial: redraw keeps the selection; no scroll-up hold |
| 105 | A question just asked keeps its row where it was on screen (keepAsked, 3 s); the reply field takes the keyboard when the answer lands if nothing else was done | :3196 :2753 | hooks.asked | todo: EditorCore.hooks.asked fires, the view does not hold the row yet |
| 106 | Mentions open in the pane beside are marked #e8f0fe | markBeside :848 | RenderContext.beside | compiled, untested |
| 107 | Empty hint on the last line (#b5b5b5), never in the text | emptyHintCss :206 | DocEditorView.placeOverlays | compiled, untested |
| 108 | Compact (post-it): no scrolling of its own, no card controls, fits its lines | render :5134 | DocEditorView.compact | partial: compact sizing not tuned |
| 109 | Column 65ch of 17px type, page padding 28px top, clamp(12px,4%,40px) sides, half a window below the last line; text 17px/1.6 #171717; no zoom | DOC_COLUMN, render | Look.column, layoutColumn | partial: bottom space is a fixed inset, not half a window |
| 110 | Keys ⌥⌫ word and ⌘⌫ line delete as one range | NSTextView mechanics | DocEditorView.command | compiled, untested |
