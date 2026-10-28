# Parity ledger: Doc (EngelbartDoc)

The pure document model under the editor: `src/renderer/model/doc.js` and the small models around it, the shared
mention/passage/citation helpers, `main/context/expand-mentions.cjs` and `main/bart/question.cjs`. Tests:
`mac/Packages/Doc/Tests` (DocModelTests = test/doc-model.test.cjs; QuestionTests = bart.test.cjs flag tests +
discover-levels.test.cjs; ExpandMentionsTests = expand-mentions.test.cjs + image-mentions; SharedModelTests = cite,
cite-circles, cite-open, paste-model, doc-find, kind, key-side, selection-card, folder/website mentions, math).

Offsets are UTF-16 code units everywhere (JavaScript's, and NSTextView's), via `String.len/slice` in JS.swift. Regexes are
the JS source through `Rx`, which rewrites `\w`/`\d` to ASCII, `\s`/`\S` to JavaScript's whitespace (JSSpace), `$` to end-of-input, and escapes `[` inside classes.

Status `done` = covered by a test in DocPackageTests, which passed in the cloud (GitHub Actions run 40757979494,
2026-10-28, 83 tests: https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/40757979494). Rows with
"compiled, untested" have no test of their own yet.

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | `- [ ] t`/`- [x] t`/`- []` are todos; `- []one` and `- [x]done` are bullets with that text (the checkbox needs its space) | doc.js TODO_RE, doc-model test | Line.swift parseLine | done |
| 2 | `- x`/`* x` bullet; `1. x`/`12) x` numbered list keeping num+delim; `1.5 litres`/`1.no` are text; depth = indent/2 capped at 8 | doc.js LIST_RE depthOf | Line.swift | done |
| 3 | `# `..`### ` headings (level 1–3); `####` is text | HEAD_RE | Line.swift | done |
| 4 | `@chat x` → bart line (agent nil = Chat); `@bart` → agent router; @brainstorm/@discover/@create/@orient, case-insensitive, `@bartty` is text | BART_RE | Line.swift | done |
| 5 | `bart~> <id>` pending; `build> <10 hex>` build card; `bart> `/`bart+> ` reply (folded); `bart?> ` old draft reads as reply | PENDING/BUILD/REPLY/DRAFT_RE | Line.swift | done |
| 6 | `bart# [agent build at] Title` / `bart#+` title line with meta; brackets that keep nothing are the title; a title not followed by a question parses as `p` | TITLE_RE, titleMeta, parseLines | Line.swift, Doc.titleMeta/titleLine | done |
| 7 | `> q`/`>q` quote; `![alt](img:id|https:…|data:image…)` image line | QUOTE_RE IMG_RE | Line.swift | done |
| 8 | Closed fences only make code blocks (``` or ~~~, ≥3, same char, closing ≥ opening, ≤3 spaces indent); lang = first word; every inner line is `code`; `@bart` inside is code | codeBlocks/parseLines | Line.swift | done |
| 9 | Code blocks inside a run of answer lines stay `reply` with `code` open/body/close and block indexes into the document | parseLines | Line.swift | done |
| 10 | isFence/isCode/fenceShown (open fence shows its language when not active) | doc.js | Line.swift | done |
| 11 | todoLine/listLine/listMark(`•` or `7)`)/replyLine (no trimming: trailing space survives)/sameLine/canonicalLine (`- []`→`- [ ] `, `* x`→`- x`, `1) x` kept) | doc.js | Line.swift | done |
| 12 | retypedRow: a marker typed into an empty row re-types it (`- [ ] `, `- []`, `- `, `* `, `1. `), returns line + chars eaten; `@Task` no marker | retypedRow | Line.swift | done |
| 13 | isMarked (todo, list), isDrawn (+reply), lineText (drawn line → its text, else the source) | doc.js | Line.swift | done |
| 14 | placeAnswer replaces `bart~> <askId>` with lines; nil when the pending line is gone | placeAnswer | Line.swift | done |
| 15 | flattenPaste: line breaks with surrounding whitespace → one space, ends trimmed, inner tabs/spaces kept | flattenPaste | Line.swift | done |
| 16 | INLINE tokenizer: math ($…$ Pandoc rule, $$…$$, `\$`), attachments, `[[build]]`, agent tokens (followed by space/end), bold, italic, code, links, ws/lib/file/zotero/made/name mentions, bare URLs without trailing punctuation | doc.js INLINE | Inline.swift | done |
| 17 | expand-mentions' INLINE is the same definition (one shared `Inline.INLINE`) | expand-mentions.cjs + test | ExpandMentions.INLINE | done |
| 18 | tokShown: shown text, pre, unit for every token kind (math unit = drawn text; attachment `[Attachment n]` unit; citation '' unit; hammer '' unit; mentions '@'+name; lib name now via libName; address names → webLabel) | tokShown | Inline.swift | done |
| 19 | tokensOf: heading/quote prefix is its own first token; drawn lines tokenise p.text | tokensOf | Inline.swift | done |
| 20 | rawOffset display→raw (heading base level+1, quote real prefix, mention end → after `]`, units before/after, bold end inside closing marks) | rawOffset | Inline.swift | done |
| 21 | replyRawOffset: answer lines draw their own heading (no `## `), bullet `•` (1 char), number (`10.`) | replyRawOffset | Inline.swift | done |
| 22 | Mention builders: wsMention/libMention/fileMention (encodeRel, `!'()*` encoded)/zoteroMention (≤200 chars)/made mention parsing; names lose `[]\n`; empty → Workspace/Untitled | doc.js | Inline.swift | done |
| 23 | chatMention: `@[bart]` live (blue), `@[bart:id]`/`@[chat]`/`@[chat:id]` gone (grey, "This chat is gone") | chatMention, nameHtml | Inline.swift nameRun | done |
| 24 | mentionAt: `@` + ≤30 non-space chars before caret; with `holds`, up to 60 chars with spaces while a name holds them (2026-10-16) | mentionAt | Inline.swift | done |
| 25 | folderPath `@Folder/sub/`; folderMentionAt query (spaces allowed, ≤80) or `into` on a trailing `/` | folderMentionAt | Inline.swift | done |
| 26 | fileKindOf by extension (md, pdf, html, data, image, else file) | FILE_KINDS | Inline.swift | done |
| 27 | inlineHtml drawn as `InlineRun`s: strong (may hold links/mentions), code, em, agent label, mention chips with icon (ws, file kind, website/git via webKind, zotero), gone (grey + why), trashed (grey, "In trash"), links, math, math error (code look), attachment chip, hammer with buildTurn, citation circles, folded runs ≥3 | inlineHtml | Inline.swift runs | done |
| 28 | HTML output identical to inlineHtml for web contexts (styles, data-attrs, svg icons) | inlineHtml | Html.swift | done |
| 29 | A colon/dash before a citation is dropped where the circle is drawn (2026-10-22), not inside tokens | inlineHtml CITE_LEAD | Inline.swift runs | done |
| 30 | Math: no KaTeX in Swift. LaTeX → Unicode math text (Greek, operators, sup/sub, a⁄b, √, accents, \mathbb, environments); unknown command or unbalanced brace → nil → source shown in code look; cached 500 | renderMath (KaTeX) | MathText.swift | done (mapping recorded: KaTeX's drawing replaced by Unicode text; visual fidelity of stacked fractions/large operators lower) |
| 31 | textMathHtml/textMathRuns: card strings show only math drawn, `\$` a dollar | textMathHtml | Inline.swift, Html.swift | done |
| 32 | mathBlockHtml for ```math blocks (display math when caret outside) | mathBlockHtml | MathText.render(display:) used by Editor | done |
| 33 | highlight: JSON-family langs coloured (key #171717, string #0761d1, number/literal #4d4d4d, punct #8f8f8f, `//` comment italic grey); others plain; text unchanged | highlight | Copy.swift highlightRuns/highlight | done |
| 34 | holdsLink (link, bare URL, bold around a link) | holdsLink | Inline.swift | done |
| 35 | Margin notes: noteParts (lib mentions split, optional leading @bart piece), noteOffset (mention → after it), noteRuns/noteHtml, agentLabelHtml, noteInkHtml | noteParts… | Inline.swift, Html.swift | done |
| 36 | threads(): question + pending/reply lines + follow-ups; follow-up only once asked (pending/reply/build under it) unless a research box; router lines join any thread; other agents start their own; @orient own thread unless thread is @orient; Build card directly under question is the turn's answer; title line attaches routedTo/at/build/title/folded | threads/followsIn | Threads.swift | done |
| 37 | turn fields q/from/to/answered/pending/foot/folded/agent/build; foot = last reply matching `*…*` | threads | Threads.swift | done |
| 38 | turnText: question text after the agent word; answer without prefixes or the foot | turnText | Threads.swift | done |
| 39 | agentOf/tokenOf/isResearch/researchLine/researchText/isRefine/refineLine/footAgent/answeredBy | doc.js | Threads.swift | done |
| 40 | migrateChatLines: answered unrouted `@bart` → `@chat` (`@Bart`→`@Chat`), idempotent; routed ones stay | migrateChatLines | Threads.swift | done |
| 41 | whenShown: "9:41 PM" today, "Yesterday", weekday < 7 days, "Oct 3" / "Sep 3, 2025"; '' when none/invalid; askedNow to-the-second UTC | whenShown, askedNow | Threads.swift | done |
| 42 | askedAt / placeTitle (fill empty title above the question, before or after the answer lands, nearest to where it was) / retitle (unset: only an empty or "New conversation" title) / topicOfThread | doc.js | Threads.swift | done |
| 43 | answerFences: an answer's code blocks' bodies | answerFences | Threads.swift | done |
| 44 | selectionMarkdown: one line → text selected (links whole, words from titles alone); across lines marks kept, answer prefixes and feet dropped, pending/build lines skipped, line-break-only ends; code as typed; math whole unless inside its source | selectionMarkdown/cutToken/sliceInline | Copy.swift | done |
| 45 | selectionHtml: `<br>` per line; heading bold; bullets `•`, todos ☐/☑ with 4×&nbsp; per depth; code `&nbsp;` indents, fences dropped; web image link; attachments dropped; only http(s)/mailto links | selectionHtml/plainHtml | Copy.swift | done |
| 46 | withLinks: plain text from a web page gets `[title](url)` back, in order, whole-word, `()` encoded, skipping self-links/brackets/non-http | withLinks | Copy.swift | done |
| 47 | esc escapes & < > " | esc | Copy.swift | done |
| 48 | Citations: citationOf (cite=you/other/source, counter, note, whole source), citationPassage, citationNumbers by passage, citationRuns (≥3 fold), citationSource (library name, workspace folder, host, file), libraryName, citationSources, citationCard (quote, lead "Your note"/agent name, where, when, counter), streamingText (no citations or half-written links while streaming), CARD_GRACE 200 ms | cite.js | Cite.swift | done |
| 49 | citationHtml/citationMoreHtml/citationSourcesHtml/citationCardHtml/CITE_CSS (HTML only) | cite.js | Html.swift (circle, more); card/sources HTML not ported | n/a: HTML strings; the native editor draws the Sources list from Cite.citationSources (Editor row 101, cloud-tested) and the card from Cite data |
| 50 | openCitationRun / citationTip (DOM) | cite.js | — | n/a: DOM mechanics; Editor opens folded runs natively |
| 51 | splitTarget/citeHref/linkAddress (find/to/page/note/cite/counter, any order, `%26` decoding, paths decoded) | passage-link.cjs | Cite.swift PassageLink | done |
| 52 | foldPassage/normalizePassage/matchPassage (case, whitespace, quotes, dashes, ligatures, soft hyphen, hyphen-broken words, prefixes, markdown; fallbacks without hyphens/spaces) | passage-text.cjs | Cite.swift PassageText | done |
| 53 | addressKey (www, trailing slash, fragment, tracking params) / isPreviewAddress | address-key.cjs | Cite.swift AddressKey | done for addressKey (via citation numbering); isPreviewAddress done (RouteTests) (private copy; the Stage/Store may own the canonical one) |
| 54 | citedDoc (workspace document by folder path, or a note) / passageLine (person's line first for 'you', answer line for others) | cite-open.js | Cite.swift CiteOpen | done |
| 55 | webLabel (host+path, no www/query/fragment/trailing slash, ≤60 with …), webName, isAddress, sameAddress | web-name.js | WebName.swift | done |
| 56 | mentionToken for menu rows (workspace, zotero entry, folder file/self, web row by id under title, picture by id, fresh address, name); rowMention; LIB_DRAG_TYPE | mention.js | Library.swift Mention | done |
| 57 | writeLibDrag/readLibDrag/carriesLibRows (DataTransfer) | mention.js | — | n/a: pasteboard mechanics belong to the sidebar/editor drag code; type string kept |
| 58 | mentionedIds: lib ids, file mentions count their folder, plain names match rows case-insensitively, ws/zotero no rows | shared/mentions.cjs | Library.swift | done |
| 59 | kindKey/kindRank/kindLabel/isNote/hasTag/LIBRARY_CHIPS/libraryFilter/libraryCounts (pictures under none; create-made under All+Assets) | kind.js | Library.swift Kind | done |
| 60 | isUntitled/nextUntitled/wsLabel (9 chars, 8+…) | names.js | Library.swift Names | done |
| 61 | askLineTexts/findAskLine (nearest, `@bart` rewritten to routed agent)/findBuildLine | askLine.js | Library.swift AskLine | done |
| 62 | expandMentions: note blocks whole and recursive, once (`seen`), circles end; other rows with summary; missing notes/mentions; workspace blocks; folder files (folder counted); Zotero blocks; pasted images → paths, mentioned picture once; blank-line rules | expand-mentions.cjs | ExpandMentions.swift | done |
| 63 | expandRows, imagePaths, buildLines (`Build "title" (status)`), projectSource (this project's row wins a name; pictures by id only), expandDoc composition (`# Title`, blank) | expand-mentions.cjs | ExpandMentions.swift | done (ExpandMentionsTests testExpandRows/testExpandDoc; reading the document and its name are the Store's) |
| 64 | readFlags (from both ends, `--extra high`, spans), effortOf, modelOf (loose), above, ladderOf (start pick), readQuestion (nearest effort, pinned step) | question.cjs | Question.swift | done |
| 65 | readMode/readProvider/readRefine/levelOf/readDiscover (carried mode/provider from earlier turns)/withMode (plain mode/provider)/discoverSpans/readBuildFlag/buildRequestOf/withChoice | question.cjs | Question.swift | done |
| 66 | Models file order: JSON objects lose key order in Swift; providers/models ordered by the shipped defaults (openai, anthropic; luna sol astra haiku sonnet opus fable), others alphabetical | models.cjs normalizeModels | Question.swift QuestionModels(json:) | done (mapping recorded) |
| 67 | pdfText/pdfChars: hard-wrapped PDF text rejoined (hyphen mend, page numbers, items, short sentence-ending lines end paragraphs); else only character cleanup | paste.js | Models.swift PdfPaste | done |
| 68 | segmentMatches (case-folded, across one block's segments, ends in the last letter's segment, non-overlapping, length-changing lowercase kept as written) | doc-find.js | Models.swift DocFind | done |
| 69 | nextFind (fresh/step wrap/fromStart/relayout) | find.js | Models.swift DocFind | done |
| 70 | createTargetGate/sectionSpans/paintSection/clearFind | find.js | — | n/a: PDF package's (PaperView) |
| 71 | DocSync: revisions per key; announcements ignored if older; wait while saving; take or conflict after | doc-sync.js | Models.swift DocSync | done |
| 72 | Key side tracker (press/focus/left/page), docHasKeys, docClose (pane beside, else tab; never ws or the last tab) | key-side.js | Models.swift SideTracker/KeySide | done |
| 73 | readDrop (files first, then first http uri-list line, Google imgres unwrapped, then first <img> src, data: image bytes ≤28 MB), isPastable (png/jpeg/gif/webp), firstImageSource | drop.js | Models.swift Drop | done |
| 74 | addDropped (API calls one at a time, problems collected) | drop.js | — | n/a: the app's library adapter does it (Store API) |
| 75 | selectionCardPlace (below/above/clamped, 8px gap, nil off-pane) and shadedCardPlace (340 wide card, shade 18/24/30) | selection-card.cjs | Models.swift SelectionCard | done for place; shadedPlace done (RouteTests) |
| 76 | answerOf/askEntry/withAsk (mark answers, `web` list, crop kept when it matches crops/…png) | mark-answers.cjs | Models.swift MarkAnswers | done for answerOf; askEntry/withAsk done (RouteTests) |
| 77 | markdownBlocks/inlineRuns for markdown read on the Stage | markdown.js | Models.swift MarkdownFile | done |
| 78 | Thread type named `DocThread` (Foundation has `Thread`) | — | Threads.swift | done |
| 79 | route.js: questionLine (plain, ≤80 at a word), routeByRule (empty→brainstorm, --build, level flags, answering Discover), buildTextOf, fallbackAgent, routeInputs (section, threads, spec, specTitle, current, asking) | model/route.js | Route.swift | done (RouteTests, cloud run 40754252113) |
| 80 | card.cjs as the editor reads it: cardOfAnswer (```json fence, a card that asks), readCard/cleanCard (focus/questions, ≥2 rows, clips), questionOf/labels, cardAsText, isChoice, answerLine (picks of the card only, note, Skip), readWrap/withWrap/readAnswer (picked "…", a row named in words), recapLine (labels, ’ and ：), resultParts/resultText/isResultOffer (old @bart offer too); same shapes as Bart's, Bart links to these | main/bart/card.cjs | Card.swift | done (CardTests) |
| 81 | expand-mentions' `seen` keeps JS Set order: keys read back in the order first added (nested after the note holding them, repeats add nothing) | expand-mentions.cjs | ExpandMentions.swift SeenKeys | done (testSeenKeepsFirstSeenOrder) |
| 82 | JavaScript whitespace exactly (\s and trim(): \t \n \v \f \r, space, U+00A0, U+1680, U+2000–200A, U+2028/9, U+202F, U+205F, U+3000, U+FEFF; not U+0085 or U+180E) in trim/trimStart/trimEnd, Rx `\s`/`\S` (ICU's lacks \v and U+FEFF) and PassageText.isSpace | JS semantics | JS.swift JSSpace, Cite.swift | done (testJavaScriptWhitespace) |
