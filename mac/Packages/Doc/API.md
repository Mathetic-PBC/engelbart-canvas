# EngelbartDoc — API

Pure Swift (Foundation + EngelbartCore), no AppKit. The document model under the editor and the helpers other packages
share. Every offset is UTF-16 (JavaScript's and NSTextView's). Ledger: `mac/parity/doc.md`.

## Strings and regexes (JS.swift)
- `String.len`, `slice(_:_:)`, `charAt`, `indexOf`, `jsSplit`, `trimmed`, `encodeURIComponent`, `decodeURIComponent`.
- `Rx(pattern, flags)`: a JavaScript regex (`test`, `match`, `matchAll`, `split` with captures, `tokens` = split+filter,
  `replace`). Write patterns as the JS source has them.

## Lines (Line.swift) — `enum Doc`
- `Doc.parseLine(_:) -> ParsedLine`, `Doc.parseLines(_:) -> [ParsedLine]` (code blocks, answer code, lone titles).
- `ParsedLine { type: LineType (.p .h .todo .list .quote .img .bart .build .pending .title .reply .fence .code), text,
  depth, done, num, delim, level, src, id, agent, folded, at, build, open, lang, block: CodeBlock?, code: CodeRole? }`.
- Builders: `todoLine`, `listLine`, `listMark`, `replyLine`, `sameLine`, `canonicalLine`, `retypedRow`, `buildLine`,
  `titleLine`, `titleMeta`. Predicates: `isMarked`, `isDrawn`, `lineText`, `isFence`, `isCode`, `fenceShown`, `isAnswer`.
- `placeAnswer`, `flattenPaste`, `Doc.lines(text)`.
- Regexes: `DocRx.TODO/LIST/HEAD/IMG/BART/PENDING/BUILD/DRAFT/REPLY/TITLE/ATTRIBUTION/QUOTE/ATTACH/FENCE`.

## Inline (Inline.swift, Html.swift, MathText.swift)
- `Inline.INLINE` (the one tokenizer; ExpandMentions uses the same object), `Inline.tokens(text)`.
- `Inline.tokShown`, `tokensOf`, `rawOffset(p, displayOffset, line:, opts)`, `replyRawOffset`, `holdsLink`.
- Mentions: `wsMention`, `libMention`, `fileMention`/`fileMentionOf`, `zoteroMention`/`zoteroMentionOf`, `madeMentionOf`,
  `encodeRel`/`decodeRel`, `chatMention`, `fileKindOf`, `mentionAt(text, caret, holds:)`, `folderPath`, `folderMentionAt`.
- Drawing: `Inline.runs(text, InlineOpts) -> [InlineRun]` (native editor); `InlineHtml.html(text, opts)` (identical to
  doc.js inlineHtml, for web views); `Inline.textMathRuns`, `noteParts`, `noteOffset`, `noteRuns`, `InlineHtml.noteHtml`.
- `InlineOpts`: `libName(id) -> NameNow (.unknown/.gone/.name)`, `named(name) -> Bool?`, `trashed(name, id)`,
  `webKind(name, id) -> "website"|"git"|nil`, `fileState(folderId, rel) -> FileState`, `buildTurn`, `cites`, `citeSource`.
- `MathText.render(tex, display:) -> String?` — Unicode math text; nil = undrawable (shown as code). Replaces KaTeX.

## Threads and answers (Threads.swift)
- `Doc.threads(lines) -> [DocThread]` (`DocThread { from, to, turns: [Turn], agent, asked, routedTo, at, build, title,
  titleLine, folded }`, `Turn { q, from, to, answered, pending, foot, folded, agent, build }`).
- `turnText`, `answeredBy`, `agentOf`, `tokenOf`, `footAgent`, research/refine helpers, `migrateChatLines`,
  `answerFences`, `whenShown`, `askedNow`, `askedAt`, `placeTitle`, `retitle`, `topicOfThread`, `UNSET_TOPIC`.

## Copy (Copy.swift)
- `DocPoint { line, offset }`; `Doc.selectionMarkdown(lines, start, end)`, `Doc.selectionHtml(markdown)`,
  `Doc.withLinks(plain, anchors)`, `Doc.esc`, `Doc.highlightRuns(text, lang)` / `Doc.highlight` (HTML), `CodeLook`.

## Citations and passages (Cite.swift)
- `PassageLink.splitTarget/citeHref/linkAddress`, `PassageText.fold/normalizePassage/matchPassage`,
  `AddressKey.addressKey/isPreviewAddress`, `Cite.citationOf/citationPassage/citationNumbers/citationRuns/
  citationSource/libraryName/citationSources/citationCard/streamingText`, `CiteOpen.citedDoc/passageLine`.

## Library-facing models (Library.swift)
- `LibRow` (the app maps Store rows onto it). `Kind.isNote/hasTag/kindKey/kindRank/kindLabel/LIBRARY_CHIPS/
  libraryFilter/libraryCounts`, `Names.isUntitled/nextUntitled/wsLabel`, `MenuItem`, `Mention.mentionToken/rowMention/
  isWebRow/mentionedIds/LIB_DRAG_TYPE`, `AskLine.findAskLine/findBuildLine`.

## Agents' lines (Question.swift) — question.cjs
- `QuestionModels` (ordered providers/models; `.defaults` = models.cjs DEFAULT_MODELS; `init?(json:)`).
- `Question.readFlags/readQuestion/readDiscover/withMode/discoverSpans/readBuildFlag/buildRequestOf/withChoice/
  effortOf/modelOf/ladderOf/levelOf/readMode/readProvider/readRefine`, `EFFORTS`, `EFFORT_LABELS`, `MODES`.

## Context (ExpandMentions.swift) — expand-mentions.cjs behind a resolver
- `MentionSource` (closures: `find`, `get?`, `read` async, `image`, `workspace?` async, `file?`, `zotero?` async);
  `MentionSource.project(projectId, rows:, read:, workspace:, file:, zotero:)` = projectSource.
- `ExpandMentions.expandMentions(text, source, seen: &seen) async -> Result{lines, files, missing}`, `expandRows`,
  `imagePaths`, `buildLines(text, task:)`, `expandDoc(title:body:source:seen:task:)`, `fileKey`, `zoteroFileKey`.

## Smaller models (Models.swift)
- `PdfPaste.pdfText/pdfChars`, `DocFind.segmentMatches/nextFind`, `DocSync`, `SideTracker`/`KeySide.docHasKeys/docClose`,
  `Drop.readDrop/isPastable/firstImageSource/pictureBehind`, `SelectionCard.place/shadedPlace`,
  `MarkAnswers.answerOf/askEntry/withAsk`, `MarkdownFile.blocks/runs`.

## Needs from other packages
- None to build. The Store adapts its rows to `LibRow` and provides `MentionSource`; Bart supplies `QuestionModels` from
  its normalized models (or uses `.defaults`). `AddressKey` here is a private copy of shared/address-key.cjs; if the
  Store/Stage publish a canonical one, they should agree with this one's tests.
