# Parity ledger: @bart (Chat, Brainstorm, Discover, Create, router, name-chat, papers) and the context layer

Package `mac/Packages/Bart` (module `EngelbartBart`). Sources: `src/main/bart/**`, `src/main/context/**` (not
expand-mentions, which is Doc's), the bart wiring of `src/main/index.cjs` and `src/main/ipc.cjs`,
`src/renderer/model/route.js`, `src/renderer/model/intelligence.js`. Status per ARCHITECTURE §6.

Mapping notes (Electron mechanics → Swift):
- JS strings are UTF-16: every length, slice and offset here uses UTF-16 units (`JS.swift`), so cuts land where Electron's do.
- Key order matters (the order of a provider's `models` is their rank; files are written in build order): `OJ` (ordered
  JSON, `OrderedJSON.swift`) parses and writes JSON keeping key order, `JSON.stringify(v, null, 2)` byte for byte.
- `store/defaults.cjs carryDefaults` is ported inside Bart (`CarryDefaults.swift`) for the models file only (Store owns
  config.json's); a wave-1 package cannot depend on Store.
- Bart does not depend on Doc: expand-mentions comes through the `BartStore` protocol (`expandDoc`, `imagePaths`; API.md).
- Node's `execFile(shell, loginShellArgs…)` → Core `RunningProcess` (AgentShell.execute); a timeout or Stop sends SIGTERM
  (then SIGKILL after 3 s), the error message "Command failed: <shell> <args>\n<stderr>" as Node's; AbortController → Stopper.
- pdf.js → PDFKit (lines from `selectionsByLine`, rotated lines told by their box's shape); Electron's offscreen
  BrowserWindow → offscreen WKWebView (CreatedPreview); `ELECTRON_RUN_AS_NODE` node script → this executable `--mcp papers`.
- Status `done` = passed on the cloud runner (`mac/scripts/cloud-test.sh Bart`, macOS 26, no CLIs installed: fakes and a
  stubbed process). Rows 1–57 also passed a local `swift test` before the cloud-only rule. Last cloud run 2026-10-28:
  75 XCTests, PASS (actions run 40754941941).

## Lines, replies, clipping (reply.cjs, clip.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 1 | clipMiddle(text, max): fits → as is; else start + `\n[… N characters cut …]\n` (N with en-US thousands commas) + end, total ≤ max; head = ceil(room/2); no surrogate half on either side; room ≤ 0 → first max chars | clip.cjs | Reply.swift Clip | done |
| 2 | Pending line `bart~> <id>` regex `^bart~> ?([\w-]*)$`; reply prefix `bart> `; MAX_REPLY_CHARS 12000 | reply.cjs | Reply.swift | done |
| 3 | attribution: `*Agent · Name · effort · N s · moved up from A e1, then B e2*`; agent names Chat/Brainstorm/Discover/Create; routed.build → "Build"; model=false → `*Agent · N s*`; seconds = max(1, round(ms/1000)) | reply.cjs | Reply.attribution | done |
| 4 | bodyLines: \r removed, cut to 12000, trailing spaces trimmed; fenced code (``` or ~~~, ≤3 spaces indent) kept verbatim, closed by same char and ≥ length; unclosed fence closed (blank tail dropped first); outside code `> ` quote prefix flattened and blank runs collapsed to one; leading/trailing blanks dropped; first line trimStart unless a fence; empty → "No answer came back." | reply.cjs | Reply.bodyLines | done |
| 5 | replyLines: body + "" + foot when meta, each `bart> ` + line, trimEnd (blank → `bart>`) | reply.cjs | Reply.replyLines | done |
| 6 | answerText = bodyLines joined, trimmed; failureLines = `bart> **No answer.** <message, spaces squashed, ≤300>` default "The run failed." | reply.cjs | Reply | done |

## Progress (activity.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 7 | pathLabeller: relative paths as given (./ dropped); absolute inside a granted dir → relative; else basename; >48 chars → `…` + last 47; empty → "a file" | activity.cjs | Activity.pathLabeller | done |
| 8 | Claude labels: Read "Reading x", Grep "Searching code for “p”", Glob "Listing p"/"Listing files", WebSearch "Searching the web for “q”", WebFetch "Reading host" (www. dropped; bad URL "a page"), Edit/MultiEdit/NotebookEdit "Editing x", Write "Writing x", Bash → commandLabel, Agent/Task "Handing “d” to a subagent", other "Using <name≤24>"; quoted values squashed and cut to 40 with "…" | activity.cjs | Activity.claudeTool | done |
| 9 | mcp__papers__ tools: resolve "Looking up “q”", references "Reading what “id” cites", citations "Reading what cites “id”", author_works "Listing the works of “a”", related "Finding papers near “id”", search by=words "Searching papers for “q”" else "Finding papers close to “q”", other "Looking papers up" | activity.cjs paperTool | Activity.paperTool | done |
| 10 | mcp__engelbart__ tools: save_file "Saving “n” to Engelbart", duplicate_file "Duplicating <path or an item> in Engelbart", move_file_into_engelbart "Moving x into Engelbart", other "Saving to Engelbart" | activity.cjs | Activity.engelbartTool | done |
| 11 | claudeUpdate: assistant message with tool_use → activity (log); stream_event content_block_start thinking → "Thinking", text → textStart; text_delta → delta | activity.cjs | Activity.claudeUpdate | done |
| 12 | claudeReader: a Write's file named as soon as file_path arrives in input_json_delta ("Writing f"), then "Writing f · N KB" each whole KB; content_block_stop forgets it; one reader per turn | activity.cjs | Activity.claudeReader | done |
| 13 | commandLabel: unwraps `sh/bash/zsh -c '…'`; first command before | && ;; readers cat/sed/head/tail/nl/bat/less/wc → "Reading <last non-flag arg>", rg/grep/ag/ack → "Searching code for “first”", ls/find/fd/tree → "Listing files", other "Running <name>", none "Running a command" | activity.cjs | Activity.commandLabel | done |
| 14 | codexUpdate: item.started command_execution → label (log); web_search with query → log label, started without → "Searching the web"; reasoning → Thinking; mcp_tool_call started (arguments object or JSON text) → papers/engelbart/other label; file_change completed → "Editing <first path>"/files; agent_message completed → whole text | activity.cjs | Activity.codexUpdate | done |
| 15 | eventReader: only whole lines starting `{` that parse; others skipped; a handler error never fails a run | activity.cjs | Activity.event(fromLine:) + Agent runner | done |
| 16 | Feed: activity sent when it changes (log flag kept); text preview flushed at most every 100 ms as `lines` (bodyLines; [] when blank) with "Writing" activity; text starting with a prefix of "ESCALATE:" never previewed; reset() per turn/step; end() cancels | activity.cjs createFeed | Activity.swift Feed | done |

## Models, flags, choices, settings (models.cjs, question.cjs, in-force.cjs, choices.cjs, settings.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 17 | Default models file (about texts, providers openai Codex luna/sol/astra efforts low…ultra ladder sol·medium, sol·high, astra·xhigh; anthropic Claude Code haiku/sonnet/opus/fable ids claude-haiku-5-5, claude-sonnet-5-5, opus, fable, efforts low…max ladder sonnet·high, opus·high, fable·xhigh; default provider anthropic) + build, brainstorm, discover blocks, exact key order | models.cjs | ModelDefaults.swift | done |
| 18 | PAST_DEFAULT_MODELS (8 versions, oldest first) for rebuilding a base | models.cjs | ModelDefaults.past | done |
| 19 | carryDefaults three-way merge: missing file → defaults written + base in .defaults/; non-object file → value null, never written; base up to date and unchanged → no write; changed → normalized (fileShape) and written; first rewrite without a base backs the file up to .backups/<name>-<iso with : and . as ->.json; base rewritten when out of date | store/defaults.cjs | CarryDefaults.swift | done |
| 20 | normalizeModels: unknown providers dropped; model keys lowercased `^[a-z][a-z0-9]{0,23}$`, ids `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`, name trimmed ≤40 else Capitalized key, use ≤300; none valid → defaults; efforts via effortOf, deduped, none → defaults; ladder ≤5 valid steps else default ladder's steps whose model exists else first model·medium; provider kept when known | models.cjs | Models.normalize | done |
| 21 | normalizeBuild/normalizeBrainstorm/normalizeDiscover: per provider wanted step if usable, else default, else ladder[0] (build: first model, high or first effort); discover one-step 09-30 shape read as `standard` (discoverLevels) | models.cjs | Models | done |
| 22 | fileShape: discover provider in one-step shape rewritten as three levels on write | models.cjs | Models.fileShape | done |
| 23 | loadModels: carryDefaults then normalize; read-only home → file as read (or defaults); `only` → onlyProviders | models.cjs | Models.load | done |
| 24 | effortOf: case/space/_/./- insensitive words (lo, med, mid, hi, extra high, x-high, veryhigh, maximum…) | question.cjs | Question.effortOf | done |
| 25 | modelOf: digits and separators ignored; matches key, id, name, or key after claude/gpt/codex prefix; first provider in order wins | question.cjs | Question.modelOf | done |
| 26 | readFlags: `--` flags taken from the start then the end only; a non-flag word stops; "--extra high"/"--extra --high" = xhigh (start only); spans sorted; rest joined by single spaces | question.cjs | Question.readFlags | done |
| 27 | readQuestion: no flags → ladder (or last pick `start` then ladder rungs above it); effort not offered → nearest offered (higher on tie); model alone → effort of first rung with that model, else medium; effort alone → model of first rung with that effort, else first rung's | question.cjs | Question.readQuestion | done |
| 28 | readMode/readProvider/readRefine: `--quick/--standard/--deep`, `--claude/--codex/--chatgpt`, `--refine` anywhere; last wins; removed and spaces squashed | question.cjs | Question | done |
| 29 | readDiscover: mode = line's, else latest earlier turn's, else standard; provider = line's, else latest earlier's, else default; unoffered provider passed over; model/effort flags pin for that line; else the models file's discover level, else ladder[0] | question.cjs | Question.readDiscover | done |
| 30 | withMode, discoverSpans (offsets of the original text), readBuildFlag/buildRequestOf (`--build` on bart/router lines only), withChoice (`--model --effort rest`) | question.cjs | Question | done |
| 31 | readBrainstorm: one step = brainstorm block's step for the default provider (usable) else default else ladder[0]; flags removed but pick nothing | models.cjs | Models.readBrainstorm | done |
| 32 | withFirstStep: pick then built-in ladder rungs above it the provider still offers | models.cjs | Models.withFirstStep | done |
| 33 | buildChoices/resolveBuildChoice: Build dialog's per-provider lists with a one-step ladder; unknown pick → defaults | models.cjs | Models | done |
| 34 | onlyProviders (none listed → all), preferUsable (provider whose CLI is usable; nil before check; build too), startingAt (bart → provider + start; build/quick → build provider + default; unoffered pick ignored) | in-force.cjs | InForce | done |
| 35 | model-choices.json: places bart/build/quick; clean keys `^[a-z][a-z0-9]{0,23}$` and known effort; remember writes `{ about, …picks }` 0600 atomically only when changed (new place last); forget only when held | choices.cjs | Choices | done |
| 36 | modelsInForce = preferUsable(startingAt(load(only), place, choice), usable) | settings.cjs | ModelSettings.modelsInForce | done |
| 37 | Settings read: models (all providers), choices, usable, offered, cli notes (not installed/signed out/out of date/cannot run), fileError text | settings.cjs | ModelSettings.read | done |
| 38 | Settings save: keys provider/buildProvider/bart/brainstorm/discover/build only; each pick checked first (error texts verbatim); only changed values written into the file as on disk (abouts, unknown keys kept; fileShape); @bart default → ladder via withFirstStep; then forget picks overruled (provider set, or default set on the pick's provider); invalid JSON file refused with "…is not valid JSON. Fix it or delete it, then save again." | settings.cjs | ModelSettings.save | done |
| 39 | Settings forget(place) ("Use default"); place must be bart/build/quick | settings.cjs | ModelSettings.forget | done |

## Cards (card.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 40 | jsonBlocks: balanced top-level {...}, strings and escapes respected, unclosed { skipped | card.cjs | Card.jsonBlocks | done |
| 41 | parseJson: bare, ```json fence, words around (first { to last }), else last block that parses as an object | card.cjs | Card.parseJson | done |
| 42 | cleanCard: none/ready → recap (needs say); focus ≥2 options (≤6, deduped case-insensitively, `"`→`'`, label ≤200, why ≤300) title ≤300 default "What should we focus on?"; questions: first object item, type mcq/select_all/free/open, title ≤300, id ≤40 default q, subtitle, options ≥2 for choice types, placeholder ≤120, eyebrow ≤60; map groups settled/open/untouched ≤4 items {text≤200, from≤160}; say clipText ≤1500 | card.cjs | Card.cleanCard | done |
| 43 | cardBody: card → "```json\n" + JSON.stringify(card,null,2) + "\n```" (key order say, card, map?, focus/questions, ready); recap → say; else text as is | card.cjs | Card.cardBody | done |
| 44 | cardOfAnswer, questionOf, cardAsText (say, title, "- label" lines), isChoice, answerLine (picks/note/text; nothing → "(skipped)"), readWrap/withWrap, readAnswer (picked "a", "b"; note:; label typed by hand = pick), answersSoFar | card.cjs | Card | done |
| 45 | recapParts (Look for lines ≤2, ≤140), recapLine labels (’ → '), nextLead/nextTitle, sameWords (letters/digits/' words), resultText/resultParts, isResultOffer (old @bart wording too) | card.cjs | Card | done |

## Prompts (system-prompt.cjs, brainstorm-*, discover-*, create-*, route-*, personality.cjs, context/summary-prompt.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 46 | Every built-in prompt copied verbatim (generated from the JS modules; lengths checked in a test): personality, Chat, Brainstorm, Welcome, Discover, Create, router, summary | *-system-prompt.cjs | Prompts.swift | done |

## Highlights, strip, passages (highlights.cjs, strip.cjs, shared/passage-*.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 47 | marksOf: pages = integer keys ≥1, marks sorted page, y, index; a `group` joins marks across pages (quotes/notes "\n"-joined, asks together, first page); boxes listed whatever they say; empty marks dropped | highlights.cjs | Highlights.marksOf | done |
| 48 | webMarksOf: the "web" list in ink order; quote = quote.exact (or a string); boxes `<box crop>` with crop path under annotations/ (CROP_RE `crops/<id>.png`), an ask on an older picture carries its own crop | highlights.cjs | Highlights.webMarksOf | done |
| 49 | highlightXml: quote ≤600, box text ≤2000, note ≤1500, question ≤600, answer ≤1500 (clipMiddle); empty → self-closing tag | highlights.cjs | Highlights.highlightXml | done |
| 50 | stageBlock (budget 6000): page in view, then nearest pages (earlier on ties), noted before bare, page order shown, `<more n>`; none → one line highlights="0" | highlights.cjs | Highlights.stageBlock | done |
| 51 | webStageBlock: live selection (<selection><quote>, <page_text>) and <screenshot path> first, outside the budget; annotations attr only when kept | highlights.cjs | Highlights.webStageBlock/liveXml | done |
| 52 | mentionedBlock (budget 14000 shared): items without highlights left out; frames reserved; first, second… highlight of each in turn; noted first; per item `<more n>` | highlights.cjs | Highlights.mentionedBlock | done |
| 53 | stripAgentReplies: other agents' reply runs → one "[agent reply omitted]"; asking agent's own threads kept; @orient = brainstorm, @chat = bart, @bart = router (or the agent its title bracket names); mentions under a line stay with it, under an omitted reply go too | strip.cjs | Strip.stripAgentReplies | done |
| 54 | show mode (2026-10-14): runs as `<reply agent="Chat">…</reply>` without the foot (foot names the agent), nearest the pending line first within 40,000 chars; farther `left_out="N characters, farther from this line"`; empty pending → status="still being written" | strip.cjs | Strip.stripAgentReplies(show:) | done |
| 55 | topicOf: up from the pending line through turns/mentions to the title; only a [brainstorm …] title that is not "New conversation"; stripTitles drops `bart#` lines | strip.cjs | Strip.topicOf/stripTitles | done |
| 56 | splitTarget/citeHref/linkAddress: find/to/page/note/cite/counter in any order; whole-source fragments; path percent-decoding; parentheses encoded | shared/passage-link.cjs | Passage.swift PassageLink | done |
| 57 | foldPassage/matchPassage: case, whitespace, quotes, dashes, ligatures, soft hyphen, broken words, workspace prefixes, markdown marks; retries without hyphens, then without spaces; offsets map back (UTF-16) | shared/passage-text.cjs | Passage.swift PassageText | done |

## Discover's trace, papers, run log (trace.cjs, papers.cjs, papers-mcp.cjs, runlog.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 58 | Trace groups (Starting papers, Papers they cite, Newer papers that cite them, Reading the papers, Essays and posts, Your notes and files), ≤30 lines each; lines by what came back (Found “…” in your library / Picked “…”, the Nth closest of N / Listed the N papers … cites / Found N newer papers that cite … / No paper cites … yet / Couldn’t …); lookups after the trace one "Checking whether … fit(s)" line; Codex web_search open_page → reading; story { groups, latest, now, last } | trace.cjs | Trace.swift | done |
| 59 | Paper tools over OpenAlex (resolve, references, citations, author_works, related, search by meaning spaced 1.1 s with words fallback on a 4xx not 429); records (list/full), abstract from inverted index ≤4000, arXiv/DOI/W-id lookup, arXiv title fallback; retry once after 1.5 s on network/429/5xx; error texts verbatim; api_key when OPENALEX_API_KEY | papers.cjs | Papers.swift | done |
| 60 | `--mcp papers`: tools/list with readOnly annotations (answered in Bart: Core.MCPServer writes no annotations), tools/call through Core.MCPServer; invalid argument → "Invalid argument: x." | papers-mcp.cjs, papers.cjs callTool | PapersMCP | partial: tools/list (annotations) and tools/call tested; the stdio loop of `PapersMCP.run` compiled, not run |
| 61 | Run log: agent-runs.jsonl, prompt lines by hash (sha256 16 hex), run lines at start and finish, last wins, running→stopped on load, ≤300 runs, rewrite at 2× lines; step/event/output/note/finish/amend/find/list/get; ≤1000 tool calls a step (toolsDropped); toolCallsOf for Claude and Codex (command, web_search, mcp) with 2,000-char excerpts | runlog.cjs | RunLog.swift | done |

## Catalog, settings logic, CLI launching

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 62 | buildCatalog v2: about text, project {id,name,root,directory}, workspaces {id,name,path,document,chars}, entries filtered by holder (removed / letGo / project_id / library / contexts), path relative inside the project, summaryStale = summary && (!summary_edited || summary_edited < changedAt (pdf mtime ISO)) | context/catalog.cjs, shared/project-holds.cjs | Catalog.swift | done |
| 63 | writeCatalogs: rewrite <project>/.context/catalog.json only when content (generated aside) changed; returns files written | context/catalog.cjs | Catalog.writeCatalogs | done |
| 64 | Intelligence panel logic: rows (@chat and @create, @brainstorm, @discover, Build+quick), shown providers, default provider as a run sees it, defaultStep, cellModels, effortFor, patchOf, stepLabel ("Opus Extra high"), lastPick, followedPick | renderer/model/intelligence.js, ModelGrid effortFor | Intelligence.swift | done |
| 65 | CLI runs through the login shell (`$SHELL -ilc`, fish `--login --interactive --command`), ENGELBART_GIT_BIN first / ENGELBART_AGENT_PATH last on PATH; env sanitized (transient keys, ELECTRON_*, inspector), TERM etc. set, outer agent session scrubbed, API keys removed, tools' env; binary by $ENGELBART_<NAME>_BIN when the check found it off PATH | terminal/launch.cjs, shell-rc.cjs, summarizer.cjs | AgentShell.swift | done |
| 66 | prepareCodexHome: refuses unless auth.json auth_mode chatgpt with tokens; symlinks auth.json; AGENTS.md written when it differs; lastResultLine / lastUsage | context/summarizer.cjs | AgentShell.swift | done |

## The ask (ask.cjs, context.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 67 | climb: answer ends it; `ESCALATE: why` (<500 chars, why ≤400) → next step resumes the same session with "You asked to move up…"; at the top once "No higher step exists. Answer the question now…", then "I could not answer this at the highest step available. <why>"; <level> block texts (pinned / step n of N / higher step) verbatim; step progress (name/effort hidden for @brainstorm) | ask.cjs climb, levelBlock | AskPlan.climb | done |
| 68 | Threads: keyed by sha256(JSON.stringify([projectId, kind, id‖workspaceId, [[q,a]…]])); take removes (wrong provider → nil); keep restarts the idle clock (30 min @bart, 2 h brainstorm/discover); persisted [[key,{provider,session,projectId,workspaceId,at}]] 0600 in bart-/brainstorm-/discover-threads.json; reload keeps only those still inside their window | ask.cjs createThreads, threadKey; index.cjs | AskPlan.swift Threads | done |
| 69 | Turns cleaned: last 40, question ≤8000 / answer ≤20000 clipped in the middle, --research/--steer/--refine shown as words; empty questions kept for brainstorm/discover; a follow-up of another agent (switched) starts a new session | ask.cjs cleanTurn(s), switched | AskPlan | done |
| 70 | firstMessage: new session = head, context_json, mentioned_files, documents, <conversation> (turns labelled by agent when mixed), extra, level, [routed build block][topic]<question>; resumed = extra, now (@bart's <stage>/<highlights>), level, question; images as file paths | ask.cjs firstMessage, context.cjs conversationBlock | AskPlan.firstMessage | done |
| 71 | turnPlan: @bart/@create readQuestion (Regenerate's choice rewrites flags); @brainstorm one step, Regenerate's pick for that run, empty line = "Start from this workspace.", older cards as text; @discover mode/provider carried, `--research` = search (<mode> + <search>), `--refine` and the turns after it = <refine> with the last searched direction; Welcome walkthrough: first → stage card (written, no model) → next → result (resultText, `welcome: 'result'`) | ask.cjs turnPlan, welcomeReply, resultReply, welcomeHere | AskPlan.turnPlan, Bart | done |
| 72 | replyBody: copied foot (`*Chat · …*`) dropped; Discover guide starts at its first `## `; Discover/Brainstorm cards kept as fenced JSON (opening card ≤4 topic labels, no why); takeTopic (`<topic>` → title-cased label), takeResearch (`<research>` → one line ≤1000, never from a search turn); a bare Discover opening that asks is the question alone | ask.cjs replyBody, taken, opened, topicsOnly | AskPlan | done |
| 73 | Real runner, Claude Code: `exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id/--resume "$…SESSION" --restricted --setting-sources "" --strict-mcp-config[ --mcp-config] --tools "…" --allowedTools "…"(or rules + --permission-mode dontAsk) --add-dir "$…DIRn" --model --effort <e> --system-prompt-file … < input`; errors "Claude Code was not found on the login shell PATH." / "did not return a result (…)." / result text ≤300 | ask.cjs claudeTurns | Bart.claudeTurns | done |
| 74 | Real runner, Codex: private CODEX_HOME (AGENTS.md = prompt, auth link, config.toml with only the papers server); `exec codex exec --color never [-C cwd] --skip-git-repo-check -m … -c 'model_reasoning_effort="e"' -c 'sandbox_mode="read-only"' (or @create's workspace-write set) -c 'tools.web_search=…' -c project_doc_max_bytes=0 --json -o out - < input`; resume = `exec codex exec [-C] resume "$…SESSION" …`; thread id from thread.started; error texts verbatim | ask.cjs codexTurns, writeCodexConfig | Bart.codexTurns | done |
| 75 | Per agent: Chat read+web tools; Brainstorm Read,Grep,Glob, no web, own home/sessions; Discover talk turns files only, search turns +paper tools (mcp__papers__*) + web, 30 min (45 deep); Create Write/Edit on its draft only, 10 min, no sessions, workspace-write sandbox | ask.cjs once() | Bart.answer | done |
| 76 | Session that will not resume → one retry as a new session; stopped search keeps its session 10 min for a steer (pausedFor stops the running search and resumes it with steerMessage) | ask.cjs ask, pause/pausedFor | Bart | done |
| 77 | Run record (runRecord) at start, step/output per climb turn, finish done/failed/stopped with lines, citations kept/dropped amended, @create created/skipped amended, router correction marked | ask.cjs runRecord, loggedTurn | Bart, RunLog | done |
| 78 | Tool lock: tools.ensure before, tools.use around each run, "unavailable" → background check | ask.cjs guarded | Bart | done |
| 79 | Chat's citations checked before writing (Cite) with what it read (openedBy), page texts kept first (keepPageTexts), notes on highlights (inkFiles incl. a paper added twice); library unreadable → every citation dropped | ask.cjs citedBody, readWhileAnswering | Bart.citedBody | partial: Cite tested (kept, dropped, relabeled to Chat, dates); citedBody wiring (openedBy, keepPageTexts, inkFiles) compiled, its parts tested apart |
| 80 | Fake agents (ENGELBART_BART_FAKE=1): streamed activities and 24-char deltas over the delay, "hard" escalates once, "code" adds JSON, "cite" adds a kept and a dropped citation; fake Brainstorm card/prose/topic, fake Discover direction/search/trace/guide incl. "## This paper", fake Create files + Build refusal, fake Welcome; Stop cancels a pause | ask.cjs createFakeBart, fake* | AskFake.swift | done |
| 81 | buildContext: workspace/note/project-page/mark documents with this ask's pending line marked `<<< this is the question being asked now >>>` and other pending lines dropped; titles stripped; @brainstorm shown others' replies and its topic read; <highlight> blocks (pdf page, web, box) and "asked from" wording; @bart <stage> (pdf, web with live selection/screenshot, Overleaf) and <highlights>, `now`; Context.json (no images; texts/notes files for Chat; summary null when stale; mentioned flag); <engelbart> head (project, description, code dir, notes dir, asked from, workspace documents for Chat, Zotero line) + custom instructions + project page + memory; --add-dir: code dir, data root, library folders (≤24, not home or /, nested collapsed), unheld pdf folders, Zotero item folders; <mentioned_files> | context.cjs | Context.swift | partial: workspace, mark (pdf) and web Stage with live selection/screenshot tested; note/project-page documents, pdf Stage ink, boxes, Overleaf and libraryDirs compiled only |
| 82 | Mentioned files and Zotero folders in the order the documents mention them (`seen` kept in insertion order, as the JS Set) | context.cjs mentionedFiles | Context.mentionedFiles | done |

## Router, naming, @create, the context layer

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 83 | Router input (<workspace>, <section> last 4000 of agent-stripped text, <threads> last 5 `- @agent, N lines up: "q"`, <spec_above>, <current>, <line>); parseReply (first `{…}` with a known agent and finite sure, clamped); decide (0.6 / 0.8 to switch / discover follow-ups → chat); model = default provider's first model at low; model flags removed from the line; fake by keyword | route.cjs | Route.swift | done |
| 84 | Router records in the run log (agent 'router', by rule/model, pick, sure, spec, unread, said, handedTo, corrected) | route.cjs routerOf | Router.route | done |
| 85 | Editor rules: empty → brainstorm, --build → build, level flag → discover, answering Discover → discover; questionLine ≤80 at a word; fallbackAgent | renderer/model/route.js | RouteRules | done |
| 86 | routeInputs/buildTextOf (threads, section, spec above, current, asking) | renderer/model/route.js | — | n/a: reads Doc's thread model; the editor builds RouteRequest |
| 87 | Titles: providerOf, namingStep (first model, low), plainTitle, capTitle (60 at a word), fallback, "New conversation"; >10 words = fallback; quick run with no tools/session, 15 s | name-chat.cjs | NameChat.swift | done |
| 88 | @create's making line (quick run on the lowest model, documents' last 20,000 chars, ≤25 words) and createdLine ("Created …") | making.cjs | Making | done |
| 89 | @create files: draft `<dataRoot>/.create/<askId>` emptied and real-pathed; plain files only (links skipped), ≤5, ≤20 MB, library formats; kept in `<project>/.created/<askId>/` (APFS clone); `@[name](made:<id>/<rel>)` lines; "Not kept: …"; createdSentence/requestSentence; readCreated (text ≤2 MB or base64 bytes, saved row, preview); saveCreated once (`.engelbart-saved.json`), saveAllCreated as the run ends | create.cjs | Create.swift | partial: keep, readCreated and Save once (through a fake CreatedLibrary) tested; the real library save is the Store/Build adapter's |
| 90 | A page's picture: offscreen 900-wide view, no navigation or new windows, ≤4000 tall, png kept beside, reused when newer and 900 wide, one at a time | created-preview.cjs | CreatedPreview.swift | partial: compiled, untested (WKWebView) |
| 91 | Summarizer: request `<file name>…</file>` + `<current_summary>`; fitSummary <1000 cut at a sentence past 400 or "…"; custom prompt file; Claude `-p --output-format json --no-session-persistence … --tools ""`, Codex `--ephemeral -s read-only`; >1.5M chars → too-long; settings normalized (aliases, efforts low…max, defaults gpt-6-luna/claude-opus-5-5 high); fake summarizer text | summarizer.cjs, home.cjs normalizeSummarizer | Summaries.swift | partial: request/fit/settings/fake tested; CLI paths compiled |
| 92 | Sweep: text pass first (every pdf, read when its mtime changes, '' kept for scans); notes quiet 30 min, >1000 chars, null vs stale summary, shorter → cleared; pdf abstract = summary (no model), else extracted text; ≤5 dispatches a sweep, retry backoff 5·2^(n−1) min (≤8 h; too-long 24 h→8 h cap), unavailable pauses 10 min; source changed meanwhile → discarded; catalogs written; status.json with providerPausedUntil and spentUsdThisRun; once a minute, 5 s after start, sweepSoon 1.5 s, stop() | sweeper.cjs | Sweeper | partial: note summary, char count, catalog and status tested; pdf paths and timers untested |
| 93 | pdf text: lines by baseline, rotated text apart, Abstract heading alone or run-in, stops at next section / heading-sized line / paragraph end at a column break, ≤4000 cut at a sentence; extractText ≤120 pages | pdf-text.cjs | PdfText | done |
| 94 | Paper or not: arXiv stamp, or two of DOI / Abstract / Keywords / References (≤60 pages); pdfTitle (metadata Title unless untitled/template/identifier) | pdf-kind.cjs | PdfKind | done |
| 95 | Shots: `<dataRoot>/bart-shots/<id>.png` 0600, last 20 kept (newest whatever its time) | shots.cjs | Shots | done |
| 96 | Source texts: `assets/text/<id>-<stamp>.txt` for kept text, older ones removed; notes files `assets/notes/<id>-<mtime>.txt`; openedBy (Read, Grep file, WebFetch, Codex commands naming known files or kept texts); keepPageTexts fetches html without cookies, 8 s, ≤4 MB | source-text.cjs | SourceText | done |
| 97 | ask-bart handler: validation texts verbatim; highlight asks tracked (progress merged, step resets activity/lines, log ≤60), box crop at ask time, answer put on the mark (askEntry), `paper-ask-done`; agent started/finished/stopped; failure → `{ failed, lines: failureLines }`, Stop → `{ stopped: true }` | ipc.cjs ask-bart, mark-answers askEntry | BartIPC | done |
| 98 | route-line (cuts not refusals), route-handed, stop-bart, name-chat (fallback without a namer), bart-models (provider, providers with start, discover levels of offered providers), remember-model-choice (build/quick only), settings-models / save / clear + models-changed, created-file / created-save | ipc.cjs | BartIPC | partial: bart-models, name-chat tested; others compiled |
| 99 | copy-doc (the sidebar's Copy: expandDoc + clipboard) | ipc.cjs copy-doc | — | n/a: Doc's expandDoc and the app's clipboard; nothing of Bart's in it |
| 100 | Chat Benchmark (askChat over the notes' questions) and the Agent Viewer window/reveal | index.cjs, agent-map/* | — | n/a: Integrations owns agent-map; it runs Bart and reads RunLog |
