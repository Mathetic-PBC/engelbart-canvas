# Connect / Import your context — parity ledger

Area: `src/main/connect/**`, `src/main/onboarding/**` (backend), `src/shared/connect-sources.cjs`, `src/shared/import-flow.cjs`,
the connect/import IPC in `ipc.cjs`/`index.cjs`/`preload.cjs`. Swift: `mac/Packages/Connect` (module `EngelbartConnect`).
Paths in the Swift column are relative to `mac/Packages/Connect/Sources/EngelbartConnect/`.
Statuses: "done (cloud)" = asserted by a test that passed `mac/scripts/cloud-test.sh Connect` (123 XCTests, PASS, 2026-10-28, run 40762872329); "done: compiled, untested" = ported and compiling, not yet asserted by a test (mostly session paths exercised only indirectly by the end-to-end runs, and opening the person's own browser apps).

## shared/connect-sources.cjs

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | SOURCES: 8 groups in order notes, transcripts, email, chats, sites, papers, code, other with labels and app lists (Notes: Obsidian, Notion, Apple Notes, OneNote, Google Docs, Evernote; Meeting transcripts: Granola, Google Meet, Zoom; Email: Gmail; AI chats: ChatGPT, Codex, Claude, Claude Code, Grok, Gemini, Perplexity, Cursor; Websites: none; Papers: Zotero, Overleaf, PDFs on this Mac; Code: none; Other: Linear) | connect-sources.cjs:30 | ConnectSources.swift | done (cloud) |
| 2 | APPS table: reach (local/web/connector/signin/automation), pick, mcp, scope, also, sites, start, reads{list,read}, fallback, memory, exactly per app (Notion connector mcp.notion.com/mcp; Evernote connector scope read fallback web; Granola connector; Linear readonly mcp + also; Gmail web; ChatGPT/Claude/Grok/Gemini memory) | connect-sources.cjs:45 | ConnectSources.swift | done (cloud) |
| 3 | GOOGLE site list (drive, docs, accounts, myaccount, www.google.com, google.com) shared by Google Docs/Meet/Gmail/Gemini | :43 | ConnectSources.swift | done (cloud) |
| 4 | SIGN_IN_SITES list (accounts.google.com … auth0.com) | :88 | ConnectSources.swift | done (cloud) |
| 5 | SIGN_IN_COOKIES per app (domain + name regex); signInGroup(app) = "domain regexSource" or app; sharesSignIn(app) = app first then others in same group; signsInThroughBrowser = Google group only | :92-115 | ConnectSources.swift | done (cloud) |
| 6 | shownName: 'Google Docs' → 'Google Drive', others unchanged | :121 | ConnectSources.swift | done (cloud) |
| 7 | sourceOf/appOf/sourceOfApp (GitHub → code); categoryOfApp via GROUP_CATEGORIES (transcripts meeting, chats chat, email email, notes note, papers paper) | :125-140 | ConnectSources.swift | done (cloud) |
| 8 | ITEM_SOURCES (all apps but GitHub + engelbart, mac, web, github, create, deduped); ITEM_CATEGORIES list of 11 | :136-137 | ConnectSources.swift | done (cloud) |
| 9 | CHAT_APPS = chats group apps; recallApps filters memory apps; webApps filters reach web; fallbackOf | :142-148 | ConnectSources.swift | done (cloud) |
| 10 | READABLE_NAMES 'Chrome, Brave or Firefox'; PERIODS 182/365/null labels; DEFAULT_PERIOD_DAYS 365; cleanDays (182/365 else null); periodName | :151-159 | ConnectSources.swift | done (cloud) |

## shared/import-flow.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 11 | LOCAL_FOLDERS 'Folders on this Mac', SITES '__sites', PAUSED_APPS ['Gmail'] | import-flow.cjs:18-23 | ImportFlow.swift | done (cloud) |
| 12 | GROUPS: SOURCES minus paused apps, a group emptied by pausing dropped (Email), Code = [GitHub, Folders on this Mac]; groupOfApp (SITES → sites) | :31-35 | ImportFlow.swift | done (cloud) |
| 13 | categoryOf(value): group id or label case-insensitive, else 'other' | :38 | ImportFlow.swift | done (cloud) |
| 14 | PAUSED_TOOL regex calendars/calendly/cal.com/fantastical/outlook/gmail/mail | :45 | ImportFlow.swift | done (cloud) |
| 15 | reachOf (SITES/LOCAL_FOLDERS local; APPS reach; default local); isLocal (local/automation); isWebApp | :48-54,293 | ImportFlow.swift | done (cloud) |
| 16 | CATALOG: every group app {id, name=shownName or 'Saved URLs', group, local} plus SITES entry; CATALOG_IDS; catalogTool | :57-59 | ImportFlow.swift | done (cloud) |
| 17 | ROLES 8 names with SVG paths (Researcher, Writer, Founder, Professor, Student, Engineer, Designer, Other) | :62-72 | ImportFlow.swift | done (cloud) |
| 18 | PROVIDER_IDS anthropic/openai, names Claude Code/Codex; chooseProvider: none ready → setup; ≥2 subscribed → ask with suggested=remembered if subscribed; 1 subscribed → pick; else senior by `since` then id order | :76-103 | ImportFlow.swift | done (cloud) |
| 19 | BROWSERS 9 entries (id, name, bundle, keychain flag); browserById; browserIdOfName via DEFAULT_NAMES regex order (chromium before chrome, ^arc\b); orderBrowsers default first | :112-138 | ImportFlow.swift | done (cloud) |
| 20 | clip(value,max): whitespace collapsed, trimmed, longer → slice(max-1).trimEnd()+'…' | :142 | ImportFlow.swift | done (cloud) |
| 21 | jsonOf: strips ``` fences, first '{' to last '}', JSON.parse object else nil | :145 | ImportFlow.swift | done (cloud) |
| 22 | slug: lowercase, non [a-z0-9] runs → '-', trim '-', 48 chars, '' → 'project' | :152 | ImportFlow.swift | done (cloud) |
| 23 | readProjects: 1-5 projects, unique ids (append '-2' until unique), title ≤80, description ≤240, recent ≤24, folder only if absolute (≤1024), evidence ≤240; none → nil | :158 | ImportFlow.swift | done (cloud) |
| 24 | readTools: every catalog tool gets entry (agent said > known > unused); local+used fact stays used with method local; catalog tool named in `additional` counts as answer; additional ≤12, deduped vs catalog names, PAUSED_TOOL dropped, website must be http(s) ≤300, category via categoryOf | :183 | ImportFlow.swift | done (cloud) |
| 25 | scopeKind (folders/email/drafts/collections/repos/chats/sites/documents); emptyScope; scopeReady; scopeOptions per kind with exact labels | :217-250 | ImportFlow.swift | done (cloud) |
| 26 | importPlan text: exact lines (Bring in from …, described projects, roles, work clip 600, period, Leave out…, scope projects/note/narrowed, connector/browser/default endings) | :257 | ImportFlow.swift | done (cloud) |

## connect/provider-failure.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 27 | needsProvider(error): nil/false → false; kind 'stopped' → false; NOT_THIS (usage limit, hit your limit, rate limit, overloaded, at capacity) → false; kind 'unavailable' → true; else FAILURE_RE (not logged in, /login, sign in again, authenticat, 401, invalid api key/token, token expired, credit balance, no access, subscription required, not found on the login shell PATH, chatgpt account, codex login) | provider-failure.cjs:14-25 | Small.swift | done (cloud) |

## connect/signin-profiles.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 28 | `<dataRoot>/.connect/signin-profiles.json` {key: {browser, profile}}; get validates ids `^[\w .@()-]{1,120}$`, unreadable → {}; set refuses bad ids (false), writes pretty JSON + newline | signin-profiles.cjs | Small.swift | done (cloud) |

## connect/import-mcp.cjs (the `engelbart` MCP server of an import agent)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 29 | Served as `--mcp import <connection file>`; connection file JSON {kind, tools}: lists toolsFor(kind, tools) else all IMPORT_TOOLS; unreadable → all; start failure prints "Engelbart's import tools failed to start." exit 1; tool calls go back over the loopback capability to the one import that started it | import-mcp.cjs | ImportMCP.swift | done (cloud). Mapping: its own stdio loop, not Core's MCPServer (which returns text only; screenshots are image content) |

## connect/scan-child.cjs + offthread.cjs (the scanner off the main thread)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 30 | Jobs detect / localRepos / projectDigest answered as {id, ok, value} or {id, ok:false, error}; unknown job → "No scanner job X" | scan-child.cjs:31-53 | Discovery.swift | done (cloud). Mapping: scan-child.cjs's child process → detached Tasks off the caller (Scanner); same jobs and answers |
| 31 | readers.localChats results cached 60 s per (app, options without env) inside the scanner | scan-child.cjs:16-26 | Discovery.swift | done (cloud). Mapping: the child's 60 s cache kept in-process (Readers.keepLocalChats) |
| 32 | Folder guard rebuilt in the child from {dataRoot, answers} (accessSpec) so a grant counts | scan-child.cjs:29, offthread.cjs:67 | Discovery.swift | done (cloud). Mapping: the guard is built from the data root's answers in the job itself (no process boundary to rebuild across) |
| 33 | createScanner: job runs off the main thread; a job over timeoutMs (120 s) rejects "The scan (job) took too long"; child exit rejects waiting "The scanner stopped"; child not spawned in 5 s → broken, its jobs and all later ones done locally; no fork → local | offthread.cjs | Discovery.swift | done (cloud). Mapping: the 120 s limit enforced around the detached task |

## connect/cursor.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 34 | cursorDb path ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb, opened read-only; missing → "Cursor has no chats on this Mac"; open failure → "Cursor's database could not be opened (…120)" | cursor.cjs:18-26 | Cursor.swift | done (cloud) |
| 35 | cursorChats({days, query, limit 200}): composerData:% rows with turns; updated = lastUpdatedAt or createdAt; since filter; newest first; first = first type-1 bubble text clip 300; title clip(name or first or 'Cursor chat',120); query words all in title+first; {id,title,first,project:'',date ISO or null,turns} | cursor.cjs:31-59 | Cursor.swift | done (cloud) |
| 36 | cursorTranscript(id): id `^[0-9a-f-]{8,64}$`i else "No Cursor chat id"; turns from bubbles in header order, empty skipped, role type 1 user else assistant, consecutive same role merged with blank line; title clip(name or first turn or 'Cursor chat',120) | cursor.cjs:62-81 | Cursor.swift | done (cloud) |

## connect/own-connectors.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 37 | officialServers: every APPS mcp + also, normalized (trim, trailing / removed, lowercase) → app | own-connectors.cjs:31 | OwnConnectors.swift | done (cloud) |
| 38 | claudeServersOf: `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json` mcpServers with type http/sse and string url → {name,url,type}; unreadable → [] | :35-42 | OwnConnectors.swift | done (cloud) |
| 39 | codexServersOf(`codex mcp list --json`): enabled ≠ false, transport.url string; signedIn when auth_status in o_auth/oauth/bearer_token/unsupported and no bearer_token_env_var | :45-51 | OwnConnectors.swift | done (cloud) |
| 40 | serversFor(apps, provider): names `^[a-z][a-z0-9-]{0,40}$`, not 'engelbart', official url; codex only signed in; one per app; `own: true`; kept 5 min per provider; failures → [] ; reaches(app) | :57-86 | OwnConnectors.swift | done (cloud) |

## connect/memory.cjs (MEMORY.md)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 41 | MEMORY.md in the data root; readMemory trims, missing → '' | memory.cjs:20-28 | Small.swift | done (cloud) |
| 42 | memoryBlock: '' when none; text over 16000 cut + "\n…"; wrapped in `<memory note="MEMORY.md: what Engelbart learned …">` exact text | :31-36 | Small.swift | done (cloud) |
| 43 | scrubSecrets: 9 SECRET_PATTERNS (private keys, sk-, gh*_, xox*, AKIA, AIza, rk/pk/sk_live/test, JWT eyJ, Bearer) → [removed], then SECRET_LINE (password/passcode/passwd/api key/secret/token/private key : or =) value → [removed] unless already; returns {text, removed count} | :40-60 | Small.swift | done (cloud) |
| 44 | saveMemory: trimmed, ≤24000 chars, empty → "MEMORY.md would be empty"; existing copied to .connect/memory-history/<ISO with : and . → ->.md (dir 0700); write temp + rename, file mode 0644, trailing newline; returns {path, bytes, previous} | :66-81 | Small.swift | done (cloud) |
| 45 | localMemories: ~/.claude/CLAUDE.md as 'Claude Code', `$CODEX_HOME or ~/.codex`/AGENTS.md as 'Codex'; clipped at 8000 + "\n…"; path shown with ~ | :87-98 | Small.swift | done (cloud) |

## connect/apple-notes.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 46 | One JXA script (osascript -l JavaScript) with commands folders / list / read, verbatim SCRIPT; timeout 120 s; error -1743 / not authorized / not allowed → NOT_ALLOWED text with code NOT_ALLOWED; else "Apple Notes did not answer (first stderr line ≤200)"; bad JSON → "Apple Notes answered something unreadable" | apple-notes.cjs:14-65 | AppleNotes.swift | partial: the script compiles as JavaScript for Automation (osacompile, cloud) and runs with that argv; never run against Notes in tests (it needs the person's Automation consent) |
| 47 | noteMarkdown: data: images written to pictureDir as `<key>-<n>.<ext>` (jpeg→jpg, 0600) and linked; br, h1-3, li, b/strong, i/em, strike/s/del, a href, block closers, tags stripped, entities decoded, trailing spaces, 3+ newlines → 2; first line dropped when it equals the note's name | :67-101 | AppleNotes.swift | done (cloud) |
| 48 | permission() → {allowed, error, refused}; non-darwin → "Apple Notes is only on a Mac" | :104-113 | AppleNotes.swift | done (cloud) |
| 49 | list({folder, days, query, limit 500}): MAX_NOTES 5000; id `^x-coredata://…`; Recently Deleted dropped; days/words filters; newest first; limit clamp 1..5000 | :116-125 | AppleNotes.swift | done (cloud) |
| 50 | read(ids, {pictureDir}): valid ids, batches of 25; error rows kept {id, error}; key = sha1(id) hex first 10; name ≤200 default 'Untitled note' | :127-139 | AppleNotes.swift | done (cloud) |

## connect/skills.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 51 | SKILLS texts per app (Obsidian … Websites) verbatim, BROWSER and SIGN_IN fragments | skills.cjs:14-132 | Texts.generated.swift + Skills.swift | done (cloud) |
| 52 | skillOf(app, dataRoot): `<dataRoot>/.context/connect-skills/<App>.md` (name `^[\w .-]{1,40}$`, non-empty after trim) overrides built-in | :137-145 | Skills.swift | done (cloud) |
| 53 | skillsFor({source, apps}): sites → Websites, code → GitHub, else apps deduped; '' when none; wrapped `<skills note="How to reach each app …">` joined by blank line | :148-152 | Skills.swift | done (cloud) |

## connect/folder-access.cjs (MATH-110)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 54 | protectedFolders: Desktop, Documents, Downloads, iCloud Drive (Library/Mobile Documents/com~apple~CloudDocs, covers Library/Mobile Documents) when present, then ~/Library/CloudStorage drives sorted (driveName GoogleDrive/Dropbox/OneDrive/Box/else before '-'; twins get " (account)") | folder-access.cjs:29-60 | FolderAccess.swift | done (cloud) |
| 55 | readAnswers/writeAnswers `.connect/folders.json` {asked: {id: {answer, at}}}; legacy string answers accepted | :63-86 | FolderAccess.swift | done (cloud) |
| 56 | guard({homeDir, dataRoot, answers, picked}).readable(dir): inside picked or allowed → true; ~/Library/CloudStorage itself true; inside a blocked or never-present protected folder → false; else true | :93-112 | FolderAccess.swift | done (cloud) |
| 57 | needed(choices): all protected when PDFs on this Mac ticked with files permission (or computer); the protected folder above each ticked code folder (~ expanded) unless inside a picked folder; only those never answered | :122-143 | FolderAccess.swift | done (cloud) |
| 58 | ask(ids): reads each folder in turn (macOS prompt), ok → allowed, ENOENT skipped, else denied; answers saved | :149-165 | FolderAccess.swift | done (cloud) |

## connect/notes.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 59 | noteName(target): basename without extension, Notion's ` <32 hex>` removed, sanitizeName (control chars removed, / \ → -, : removed, whitespace collapsed, leading dots removed, ≤ MAX_NAME, '' → Untitled) | notes.cjs:27, store/home.cjs:159 | Notes.swift | done (cloud) |
| 60 | createIndex: per-root BFS file-name index (lowercased, first wins), skips dot entries and node_modules, ≤50000 entries | :32-57 | Notes.swift | done (cloud) |
| 61 | findPicture: strip #/|, decodeURI, URLs refused; absolute, beside the note, from root, else by name in the index | :60-69 | Notes.swift | done (cloud) |
| 62 | convertMarkdown: `![[pic|300]]` → picture (size alt dropped), `![[Note]]`/`[[Note#h|shown]]` → `@[Note]`, `![alt](rel.png "t")` → picture unless http/data/img/engelbart-image, `[t](x.md)` → `@[x]`; images [{token engelbart-image:N, file, alt}] | :76-98 | Notes.swift | done (cloud) |
| 63 | writeFile: pictures (png/jpg/gif/webp ≤20 MB) named from alt stem (≤60, unique -2…) and linked by name, others `[picture: alt]`; library.addMarkdownCopy(name sanitized, text, pictures, about) | :131-152 | Notes.swift | done (cloud) |
| 64 | Staged notes (legacy): `<session>/notes/<uuid>.json` {title, body, images, source, at}; stagedNotes, stagedCount, flushStaged writes into project oldest first then deletes; placeImages saves pictures via projects.saveImage → `![alt](img:id)` | :101-186 | Notes.swift | done (cloud) |

## connect/signin-window.cjs (sign in inside Engelbart)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 65 | open(app): start = SIGN_IN_PAGES[app] or APPS start; none → closed; app without SIGN_IN_COOKIES → openSite with its domains | signin-window.cjs:64-69 | SignInWindow.swift | done (cloud). Mapping: BrowserWindow → NSWindow + WKWebView on the Stage's data store; the real sign-in pages are not loaded in tests (a closed loopback https address stands in) |
| 66 | Window 460×720, min 360×480, title 'Sign in' / 'Sign in to X', white, hidden when headless; WKWebView on the Stage's persistent data store; only https navigations; https pop-ups open as child windows (same store, same UA), others refused; children closed with it | :95-171 | SignInWindow.swift | done (cloud) |
| 67 | Polls signedIn(app) every 2 s with no limit; signed in → closes, resolves 'signed-in'; closed by person → 'closed' (or `closed()` verdict); one window per sign-in group: a second open focuses it and shares the promise; close() resolves 'closed' | :111-201 | SignInWindow.swift | done (cloud) |
| 68 | Google refusal page accounts.google.com …/signin/rejected → clears __Host-*, __Secure-*, OTZ, NID on google.com/accounts/mail, resolves 'rejected' | :33-49,121-125 | SignInWindow.swift | done (cloud) |
| 69 | openSite({name,url,domains}): https only; registrable domains (last two labels); signed-in when the sites' cookie print (domain|path|name|value sorted) changed while open | :77-89,205-223 | SignInWindow.swift | done (cloud) |

## connect/fake.cjs (ENGELBART_CONNECT_FAKE / ENGELBART_BART_FAKE)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 70 | Fake interview: offers authorize for an app with `needs` (label Sign in to / Allow Engelbart to read / Choose your … folder…), waits while a survey runs or consent pending, asks one question per source (survey items as multi with first ticked + detail, else single Everything / Only the last 30 days / Leave it out), dispatches answered source; texts exact | fake.cjs:26-57 | Fake.swift | done (cloud) |
| 71 | Fake find run: Obsidian vault (.obsidian), Zoom folder with vtt/txt, PDF folders; BFS 5 levels skipping Library, dot, node_modules and unreadable | :60-94 | Fake.swift | done (cloud) |
| 72 | Fake survey: 3 items `<app-slug>-n` 'X item n' kind doc; ENGELBART_CONNECT_FAKE_NEEDS apps call needs_you then wait_for_you ×10; skipped → signedIn false | :96-106 | Fake.swift | done (cloud) |
| 73 | Fake import: notes → list_note_files + import_note_files (5); chats Claude Code → list_chats 3 + import_chats; else add_note per web app; texts "Brought in N notes." | :108-130 | Fake.swift | done (cloud) |
| 74 | Fake browse, recall (save_memory profile), memory (MEMORY_DRAFT with planted secrets), redact (removes password line only), projects (digest folders + 4 SAMPLE_PROJECTS, max 4), discover (evidence + Linear) | :136-216 | Fake.swift | done (cloud) |
| 75 | createCliGatedAgents (ENGELBART_CONNECT_FAKE_CLI): missing/broken CLI → unavailable "X was not found on the login shell PATH."; codex signed out → unavailable codex message; claude signed out → "Not logged in · Please run /login"; refuse list → "Credit balance is too low" | :228-245 | Fake.swift | done (cloud) |

## connect/web-chats.cjs (ChatGPT and Claude chats from the signed-in page)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 76 | Scripts run in the hidden browser verbatim (CHATGPT_LIST/ONE/DELETE, CLAUDE_ORG/LIST/ONE/DELETE; limit 2000): /api/auth/session token, /backend-api/conversations paged 100, project chats via gizmos/snorlax/sidebar (g-p-) and gizmos/<id>/conversations by cursor; Claude org with 'chat' capability, projects names, chat_conversations paged 100 | web-chats.cjs:25-138 | Texts.generated.swift + WebChats.swift | done (cloud): the scripts run verbatim in an agent window's WebKit page against loopback fixtures of chatgpt.com's and claude.ai's own endpoints |
| 77 | Signed in only when an answer says so: 401, no accessToken, no orgs, Claude 403 account_session_invalid/"Invalid authorization" → signed out; anything else → null and asked once more after 3 s; still unsure → "X didn't say whether you're signed in (it answered N), twice. This is not a sign-out…" (code UNSURE); signed out → "Not signed in to X in Engelbart's browser. Call needs_you with kind "signin", then try again." (SIGNED_OUT) | :20-24,144-173 | WebChats.swift | done (cloud) |
| 78 | listWebChats(page, app, {days, query, project, limit 200}): app must be ChatGPT/Claude ("app must be one of ChatGPT, Claude"); ensure start page; error with no items → "<error>. Fall back to reading the page."; id `^[\w-]{6,80}$`; time numbers <1e12 are seconds; title clip 160 'Untitled', project clip 80; query words in title+project; project substring; newest first; limit clamp 1..2000; returns {account, total, chats, partial?} | :179-199 | WebChats.swift | done (cloud) |
| 79 | readWebChat → {id, title (or first turn clip 80, or "X chat"), date, turns} via exportChat; "Not a conversation id"; "X sent no conversation"; "X's conversation could not be read" | :202-211 | WebChats.swift | done (cloud) |
| 80 | chatIdOf(app,url): chatgpt.com/(g/<gizmo>/)c/<id>, claude.ai/chat/<uuid> | :214-223 | WebChats.swift | done (cloud) |
| 81 | deleteWebChat: only when the chat's first user turn starts with the question's first 80 squashed chars ("that chat is not the question Engelbart sent, so it was left as it is"); ChatGPT PATCH is_visible false, Claude DELETE | :231-241 | WebChats.swift | done (cloud) |

## connect/gmail.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 82 | Limits: thread id `^thread-f:\d{1,20}$`, ik `^[0-9a-z]{6,20}$`, 6 accounts, 50 search, 50 a call, 300 a session; accountIndex 0–9 else "n must be the account's number from gmail_accounts (0–9)" | gmail.cjs:14-26 | Gmail.swift | done (cloud) |
| 83 | gmailPeriod: 365 → " newer_than:1y", 182 → " newer_than:6m", other n → " newer_than:<ceil n>d", none → '' | :29-34 | Gmail.swift | done (cloud) |
| 84 | inboxUrl /mail/u/<n>/, searchUrl #search/<encodeURIComponent>, printUrl ?ik=&view=pt&search=all&permthid= with errors for bad ik / id | :36-44 | Gmail.swift | done (cloud) |
| 85 | ACCOUNT_SCRIPT and SEARCH_SCRIPT(limit) verbatim (address from title or account button, GLOBALS[9]; rows wait up to 25 s) | :48-104 | Texts.generated.swift | done (cloud): both scripts run verbatim in WebKit on a Gmail-shaped page (off mail.google.com they answer signed out; with the host check stood in, address, key and rows read) |
| 86 | htmlText: comments/script/style/head/title dropped, https links as Markdown (bare when label = url), br/li/block → newlines, td/th → space, entities decoded (&#39;), lines squashed, 3+ newlines → 2 | :106-135 | Gmail.swift | done (cloud) |
| 87 | readThread: subject from font +1 bold or title minus "Gmail - "; each table.message → sender (bold, else <address>, else cell text), date (right cell), quotes dropped, recipients dropped, attachment links and sizes removed, "On … wrote:" tail dropped; no tables → whole body; sorted by date when every date parses; people unique; attachments listed | :151-203 | Gmail.swift | done (cloud) |
| 88 | lastDay (local YYYY-MM-DD of the latest parsable date); gmailSignedOut (no message table and ServiceLogin/signin/identifierId/"Sign in" title in first 20000 chars); isThreadPage (host mail.google.com + message table) | :206-229 | Gmail.swift | done (cloud) |
| 89 | gmailThreadNote: `*Gmail · <first–last date> · people*`, each message `**sender**, date` + text, "Attachments (not brought in): …", trailing newline | :232-243 | Gmail.swift | done (cloud) |
| 90 | Date.parse leniency for Gmail dates ("Fri, Oct 10, 2025 at 3:04 PM") | :159 | Gmail.swift dateOf | done (cloud) |

## connect/readers.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 91 | shownPath (~ for home), expandPath (~ or absolute only), clip (no trimEnd), cutoff(days) | readers.cjs:30-46 | Readers.swift | done (cloud) |
| 92 | walkFiles: BFS, skips .DS_Store, dot folders and SKIP_DIRS (.git node_modules .obsidian .trash __pycache__ .venv venv .cache .Trash), readable guard, max entries → truncated | :52-71 | Readers.swift | done (cloud) |
| 93 | obsidianDailyFolder from .obsidian/daily-notes.json or plugins/periodic-notes/data.json (folder or daily.folder, slashes trimmed) | :74-83 | Readers.swift | done (cloud) |
| 94 | folderOverview: totals (files, notes, pdfs, images, newest), per top folder counts with dated ratio (2 decimals), sorted notes, files, name; dailyFolder = setting or first folder with ≥5 notes ≥0.6 dated; top 30, moreFolders, truncated | :90-120 | Readers.swift | done (cloud) |
| 95 | noteFiles: .md/.markdown/.txt under dir, include/exclude relative folders, days, newest first, max 2000 | :126-142 | Readers.swift | done (cloud) |
| 96 | obsidianVaults from ~/Library/Application Support/obsidian/obsidian.json, existing folders only, {name, path, shown, open, lastOpened}, latest opened first | :147-154 | Readers.swift | done (cloud) |
| 97 | scanLines reads in 256 KB parts up to 8 MB until found (2026-10-13 "number of chats is too low") | :174-191 | Readers.swift | done (cloud) |
| 98 | claudeCodeHead: title = custom-title > ai-title > summary > first prompt (clip 120), first clip 300, cwd, automated = entrypoint sdk-cli or sidechain (sdk-ts/sdk-py are the person's); stops 400 lines after first prompt without titles; typed() excludes tags and "Caveat: " and tool_result messages | :192-224 | Readers.swift | done (cloud) |
| 99 | codexHead: session_meta cwd, automated = originator codex_exec / source exec / subagent; first = user_message unless CODEX_INJECTED tag, else response_item user message typed | :228-252 | Readers.swift | done (cloud) |
| 100 | localChats(app, {days, project, query, limit 200, automated}): Claude Code ~/.claude/projects/*/*.jsonl, Codex $CODEX_HOME/sessions/**/rollout-*.jsonl, newest first, stops at older than days, skips headless and automated, project substring, query words in title/first/project | :262-280 | Readers.swift | done (cloud) |
| 101 | localChatCounts {total, last30Days, last180Days, inPeriod?, newest}; localChatFile id shapes (`^[\w.-]{1,255}/[\w-]{1,80}$` no '..'; `^\d{4}/\d{2}/\d{2}/rollout-…$`) | :283-302 | Readers.swift | done (cloud) |
| 102 | localTranscript: turns merged by role; Codex uses event_msg user/agent messages when present else response_item messages; Claude Code skips meta, sidechain, tool results; title 'Untitled session' | :305-338 | Readers.swift | done (cloud) |
| 103 | Exports: conversations.json in file, folder or .zip (unzip -p); errors "Nothing is at …", "No conversations.json in …", "X is not a Claude or ChatGPT export"; one export cached by mtime | :343-427 | Readers.swift | done (cloud) |
| 104 | exportChat: Claude chat_messages (sender human → user; text or content) and ChatGPT mapping chain from current_node (user/assistant string parts); seconds → ms | :358-373 | Readers.swift | done (cloud) |
| 105 | exportChats / exportCounts / exportTranscript ('Untitled conversation') | :430-453 | Readers.swift | done (cloud) |
| 106 | browserProfiles: Chrome, Arc, Brave, Edge, Chromium, Vivaldi, Opera, Comet; Default and Profile N with History or Bookmarks; name from Local State info_cache (clip 60); used = History mtime; latest first; profileOf | :457-480 | Readers.swift | done (cloud) |
| 107 | browserHistory: copies History (+ -wal) to a temp folder, query urls hidden=0 since chrome time, top 5000 by visits; exclude hosts (and subdomains); by page or by site (visits summed, pages counted, first url/title); "This browser profile has no history", "The browser history could not be read" | :491-524 | Readers.swift | done (cloud) |
| 108 | browserBookmarks: url nodes http(s), folder path "Bookmarks bar / X", roots names, limit 2000 | :527-537 | Readers.swift | done (cloud). Mapping: roots visited bookmark_bar, other, synced, then the rest sorted (Electron: the file's key order, which Chrome writes in that same order) |
| 109 | linksIn: URLs in notes (trailing punctuation trimmed), count, up to 3 note names, most used first, limit 200, 5000 files | :542-560 | Readers.swift | done (cloud) |
| 110 | zoteroCollections / zoteroItems over the mirror's items.json + collections.json (nested collections, query on title authors year tags, pdf attachment not linked_url), authorsOf ("A et al." over 3, "A, B and C") | :565-610 | Readers.swift | done (cloud) |
| 111 | pdfRoots: Downloads, Documents, Desktop, Papers, Research, Dropbox, iCloud Drive + CloudStorage GoogleDrive/Dropbox/OneDrive, readable only | :616-628 | Readers.swift | done (cloud) |
| 112 | walkPdfs depth 6, skipping dot, SKIP_DIRS, PDF_SKIP (Zotero Library site-packages dist build target vendor Pods), packages (.app …) | :631-647 | Readers.swift | done (cloud) |
| 113 | pdfTitle: XMP dc:title, else /Title <FEFF hex> UTF-16BE, else /Title (…) with escapes; untitled / Microsoft Word - … / control chars → '' | :653-672 | Readers.swift | done (cloud) |
| 114 | pdfGuess: paper id → paper; personal words → personal; paper words/venues → paper; book words → book; else unclear | :678-689 | Readers.swift | done (cloud) |
| 115 | wordsOf (≥3 letters, COMMON_WORDS out, no pure digits), sharedWords (prefix match for ≥5 letters) | :692-715 | Readers.swift | done (cloud) |
| 116 | pdfFolders: nested roots once, project matching (titles of newest 300), period (olderLeftOut, olderRelated ≤5), folders with related first then count then newest, kinds, examples = matched (≤10) then newest (≤6) with " — title" (title budget 150), top 40 | :733-787 | Readers.swift | done (cloud) |
| 117 | pdfFiles: depth 12, include/exclude, days, query on name title folder, kind filter, limit 300 → {total, pdfs: [{path,name,title,folder,modified,size,kind}]} | :794-820 | Readers.swift | done (cloud) |

## connect/scan.cjs (what Engelbart finds before anyone asks)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 118 | detect: Obsidian vaults, Claude Code ~/.claude/projects, Codex sessions, Cursor db, Zoom ~/Documents/Zoom, Google Docs (Drive folders, web sign-in or Google Drive.app; signedIn), Gmail (web sign-in), Zotero (connected or ~/Zotero), PDFs (pdfRoots, 3 names), connectors (connected or app installed), automation false, web apps (signed in or installed: 'Sign in to add'); sites (browser profiles); github; localRepos | scan.cjs:36-79 | Scan.swift | done (cloud) |
| 119 | BUNDLES map of app → .app names in /Applications and ~/Applications | :25-28 | Scan.swift | done (cloud) |
| 120 | localRepos: folders of Claude Code/Codex sessions grouped; skip home itself, dot folders, /private /tmp /var; protected ones (Documents Desktop Downloads Mobile Documents) unchecked unless readable; else nearest .git up to 8 levels; sorted sessions then name; max 40 | :94-125 | Scan.swift | done (cloud) |
| 121 | chatsAtAGlance (Cursor: 400+ counts; local chats: counts, typedByYou, folders top 15, recent 20), folderAtAGlance, pdfsAtAGlance (needs folder; notAllowed text; period/examplesFirst/kinds texts verbatim) | :134-186 | Scan.swift | done (cloud) |
| 122 | scanFor(choices): per source/app evidence (Obsidian vaults ≤4 + linksInNotes, Zotero needs signin / syncing / collections ≤60 with keys, chats, Zoom with cloud line, PDFs, Apple Notes folders ≤40 with account and id, web/connector `{reach}`); sites: browsers ≤8, bookmarks count, topSites 25 (90 days), linksInObsidian, folder; papers folders; code: github repos ≤60 + missingOrgs ≤12, picked repos, folders with gitFolders / notAllowed | :196-260 | Scan.swift | done (cloud) |
| 123 | gitFolders(dir): itself with .git, else 2 levels down (dot and node_modules skipped), ≤100 | :263-269 | Scan.swift | done (cloud) |

## connect/connectors.cjs (Engelbart's own MCP sign-ins: Notion, Evernote, Granola, Linear)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 124 | CONNECTORS: every reach 'connector' app → {url, server (lowercase, non-alnum → '-'), scope, fallback, reads (list+read)} | connectors.cjs:41-42 | Connectors.swift | done (cloud) |
| 125 | Tokens per data root in `<dataRoot>/connectors.json` {app: sealed}, sealed by the system keychain (safeStorage → a Keychain-held key); no keychain → kept in memory for the run; file mode 0600, JSON indent 1 | :104-118 | Connectors.swift | done (cloud): sealed in a temporary keychain made by the test. Mapping: safeStorage → an AES-GCM key kept in the Keychain (KeychainCrypt) |
| 126 | status(app) → {app, connected, state connected / signed-out / reconnect / unavailable, reason expired / revoked / refused / no-tools, action "Connect <shown>" for reconnect & signed-out, fallback, refreshable, expiresAt, pending}; unknown app throws "<app> has no connector" | :155-170 | Connectors.swift | done (cloud) |
| 127 | signIn(app): OAuth 2.1 + PKCE S256 with dynamic client registration (client_name Engelbart, client_uri https://engelbart.mathetic.com, grant types authorization_code + refresh_token, token_endpoint_auth_method none), discovery via protected-resource metadata then authorization-server metadata, `scope` only when the app names one, `resource` indicator; page opened in the person's browser; loopback http://localhost:<port>/callback (127.0.0.1 and ::1, previous port preferred); state checked in constant time; error → "<app> sign-in was cancelled"; no code → 400; 10 min → "<app> sign-in expired. Try again."; then check(force) | :264-308 | Connectors.swift | done (cloud) |
| 128 | Callback page HTML `<h1>…</h1><p>You can close this tab and go back to Engelbart.</p>` (404 Not found, 400 not the one Engelbart started, "<app> is connected", "<app> sign-in cancelled"), CSP default-src 'none', no-store | :275-285 | Connectors.swift | done (cloud) |
| 129 | Registration reused only for the same redirect URL; saveTokens clears lapsed/unavailable and the check cache | :121-146 | Connectors.swift | done (cloud) |
| 130 | refresh(app): one at a time per app; no refresh token/client → lapsed expired; server refusal (OAuth error but not server_error / temporarily_unavailable / too_many_requests) → revoked; else unknown | :191-212 | Connectors.swift | done (cloud) |
| 131 | tokenOf: refreshed when within 2 min of its end; lapsed → tokens dropped (registration kept) with reason; couldn't tell → old token while it lasts | :215-225 | Connectors.swift | done (cloud) |
| 132 | check(app, force): at most every 5 min; signed-out/reconnect returned as is; probe = MCP initialize + tools/list over streamable HTTP with Bearer (15 s); 401 → refresh once and probe again, still 401 → revoked; 403 → unavailable refused; 200 without any reading tool → unavailable no-tools; 200 → available; else unchecked: true | :231-258 | Connectors.swift | done (cloud) |
| 133 | accessToken (null when unavailable), serversFor(apps) (checked, connected, token) → [{app, name, url, token}], serversForRun adds the person's own servers for the rest, reaches(app, provider), list, cancel, signOut (forgets tokens, onChange) | :314-363 | Connectors.swift | done (cloud) |
| 134 | onChange(status) whenever a state moves (signIn start/end, mark, signOut) → event `engelbart:connectors` | :172-180 | Connectors.swift | done (cloud) |

## connect/browser.cjs (the agents' hidden browser)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 135 | hostAllowed(url, hosts): about:blank ok; https only (http only for localhost/127.0.0.1/[::1]); exact host or subdomain | browser.cjs:43-50 | AgentBrowser.swift | done (cloud) |
| 136 | hostsFor(sites) = sites + SIGN_IN_SITES, lowercased, unique | :53-55 | AgentBrowser.swift | done (cloud) |
| 137 | READ_SCRIPT verbatim: controls with data-eb-ref refs (≤250), role/name/href/id/value (never a password's)/checked/disabled, text slice offset..offset+max (500..60000, default 8000) | :59-91 | AgentBrowser.swift | done (cloud) |
| 138 | INFO_SCRIPT (control info + spot), TYPE_SCRIPT (native value setter + input/change events; contenteditable via execCommand insertText), SCROLL_SCRIPT, TEXT_SCRIPT verbatim | :95-212 | AgentBrowser.swift | done (cloud). Mapping: clicks are a synthesized mouse click in the off-screen window (Electron: sendInputEvent); when no click reaches the element and nothing navigates, the element is clicked from the page (cloud run 40760767266 showed the synthesized click alone may not arrive) |
| 139 | Read-only rules: signsOut(url); clickRefusal (signs out / changes a setting / no name / CHANGES_RE words / form submit), typeRefusal (password → needs_you, editor, not a field, not text input, not a search box), pressRefusal (Delete/Backspace only in search; Enter/Space in fields only in search, Space on non-editor fields ok; else as click); refusal error "Refused: <why>. Engelbart's agents only open, read, scroll and search; nothing in the person's accounts is changed." and log "Didn't: <why>" | :118-177,287-290 | AgentBrowser.swift | done (cloud) |
| 140 | sendOnly (recall): typing exactly the question into an editor/textarea/textbox once is allowed, then one Send click (name ^send) or one Enter in a field | :162-167,325,342,359 | AgentBrowser.swift | done (cloud) |
| 141 | Windows: one hidden 1280×900 window per job, title "Engelbart · <label>", Stage's data store and user agent; navigation guard (job hosts while agent drives, any https while shown; sign-out pages refused) with log lines "Kept away from <host> (not one of <label>'s sites)" / "Didn't open <host>'s sign-out page"; new windows: popup while shown (https), same window when allowed, else "Kept a new window for <host> from opening"; closing a shown window hides and hands back (onClosed) | :246-284 | AgentBrowser.swift | done (cloud). Mapping: hidden BrowserWindow → an off-screen NSWindow (alpha 0, ignores the mouse) holding the WKWebView; AppKit keeps its frame near a screen |
| 142 | open (load timeout 45 s tolerated, ERR_ABORTED ignored, 600 ms settle; not allowed → "<host> is not one of the sites this import may open (sites)"), ensure (same host keeps the page), read (log "Read <host> (<title>)"), click (spot, refusal, real click, 700 ms; "No control <ref> on the page now: browser_read again"), type, press (KEYS set; "key must be one of …"), scroll (800 default, up negative, 500 ms), wait (untilText/untilGone/stable 6 polls of 500 ms, ≤120 s), screenshot (JPEG 70, ≤1280 wide, log "Looked at <host>"), evaluate (allowed host only, async wrapper, result ≤120000 chars or truncated) | :295-413 | AgentBrowser.swift | done (cloud) |
| 143 | download(url, dir): allowed hosts only, sign-out refused, fetch with the session's cookies (180 s), "<host> answered <status>", size cap 300 MB ("The file is larger than 300 MB"), name from content-disposition (filename*/filename) else last path part, unsafe chars → '-', free name (name-2…), file 0600, dir 0700; returns {path, bytes, type, url after redirects} | :214-233,419-433 | AgentBrowser.swift | done (cloud) |
| 144 | show(jobId,{title}) centers and focuses (not when headless); hide; close; closeAll; has | :435-468 | AgentBrowser.swift | done (cloud). Mapping: show = alpha 1, centred, made key; hide = see-through again |

## connect/agents.cjs (one agent turn over the claude / codex CLIs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 145 | TIMEOUTS per kind (interview 10 min, survey 15, import 45, recall 15, memory 15, redact 6, projects 4, discover 8, browse 45); BRIDGED kinds survey, import, recall, discover, browse | agents.cjs:55-56 | Agents.swift | done (cloud) |
| 146 | Transient failures (capacity, overloaded, 429/5xx, rate limit, stream/connection errors…) not lasting (usage limit, quota, credits, login, 401/403, too long, not found, invalid_request) retried after 15 s and 45 s on the same model, onUpdate "The model is busy: trying again in N s" with retry {attempt, of, reason} | :65-71,580-597 | Agents.swift | done (cloud) |
| 147 | CONNECTOR_READS for Granola and Notion; others from APPS reads; survey/discover get list only, import list+read | :92-104 | Agents.swift | done (cloud) |
| 148 | writeImportConfig: Codex home config.toml exact text (features computer_use/browser_use/browser_use_external false; engelbart server with env, timeouts 30/240, approve; connector servers with bearer_token_env_var ENGELBART_CONNECTOR_<NAME> unless own, enabled_tools = reads, timeouts 30/120); rewritten only when changed, mode 0600 | :112-131 | Agents.swift | done (cloud) |
| 149 | codexModel(model, home): the pinned model if listed in models_cache.json (visibility list), else same family suffix, else first listed | :138-148 | Agents.swift | done (cloud) |
| 150 | claudeServers: engelbart (this executable `--mcp import <connection>`) + connectors (http with Authorization header, or own as http/sse without) | :151-159 | Agents.swift | done (cloud) |
| 151 | importToolLabel per tool (exact words), updateOf (mcp__engelbart__ labels, "Asking <server>"), browseUpdateOf (screenshots kept, Claude in Chrome labels chromeToolLabel, Codex node_repl replLabel) | :162-328 | Agents.swift | done (cloud) |
| 152 | codexServersOff / codexPluginsOff from the person's config.toml (node_repl kept, chrome@ kept); tomlValue | :331-358 | Agents.swift | done (cloud) |
| 153 | claudeToolsFor: redact/projects none; unbridged Read,Grep,Glob; bridged + WebSearch,WebFetch, allowed adds mcp__engelbart__* and connector reads | :361-367 | Agents.swift | done (cloud) |
| 154 | claudeTurn command line exact (-p stream-json, --resume/--session-id, --no-session-persistence except interview, --restricted, --setting-sources "", --strict-mcp-config, --mcp-config, --no-chrome, --tools, --allowedTools, --permission-prompts none, --add-dir per dir, --model, --effort, --system-prompt-file, stdin input) through the login shell; env without API keys (NOT_THE_SUBSCRIPTION), sanitized, agent session scrubbed; files 0600 removed after | :386-411 | Agents.swift | done (cloud) |
| 155 | claudeTurn result: last `type: result` line; none → unavailable "Claude Code was not found on the login shell PATH." (exit 127) or "Claude Code did not return a result (…)."; is_error / empty → failed (≤300); aborted → stopped | :402-407 | Agents.swift | done (cloud) |
| 156 | codexTurn: private home per bridged/projects turn (`<importHome>-<stem>`, removed after), shared interview home; auth.json symlinked, AGENTS.md = system; not ChatGPT-signed-in → unavailable "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used."; command exact (exec / exec resume, -m, effort, read-only sandbox, web_search for bridged, project_doc_max_bytes=0, --json, -o); thread id from thread.started; empty → not found / last error line / failure | :413-451 | Agents.swift | done (cloud) |
| 157 | Browse (kind browse) in the agent terminal: claude -p --chrome with CHROME_REFUSED disallowed, --permission-mode auto; codex exec --ephemeral with CODEX_BROWSE_APPROVALS, person's servers/plugins off, developer_instructions, engelbart server -c, --disable apps, --enable browser_use when allowed, --disable computer_use; onUpdate({command}) shown; JSON lines read, screenshots kept ≤80 in steps/NNN.ext; transcript at the end | :460-570 | Agents.swift | done (cloud) |
| 158 | turn(): tools.ensure(cli) then tools.use(cli, once) (the CLI's lock); unavailable → tools.check([cli]) | :573-588 | Agents.swift | done (cloud) |
| 159 | Login-shell helpers copied: resolveShell (SHELL if zsh/bash/fish else /bin/zsh, /bin/bash), loginShellArgs (-ilc; fish --login --interactive --command; ENGELBART_GIT_BIN first and ENGELBART_AGENT_PATH last on PATH), sanitizeEnvironment (transient keys out, TERM xterm-256color, COLORTERM, TERM_PROGRAM Engelbart, LANG), scrubAgentSession, lastResultLine, prepareCodexHome, writeCodexConfig, pathLabeller, claudeUpdate, codexUpdate, commandLabel | terminal/launch.cjs, shell-rc.cjs, context/summarizer.cjs, bart/activity.cjs, bart/ask.cjs | CLI.swift | done (cloud) |
| 160 | The tool bridge (sandbox/local-tools openToolBridge): loopback http://127.0.0.1:<port>/tools, 64-hex token, POST only, Bearer checked in constant time, Host checked, no Origin, body ≤1 MB (413), result {content} or text JSON, errors {isError, content} (last 2000 chars) | sandbox/local-tools.cjs:218-250 | ToolBridge.swift | done (cloud) |

## connect/session.cjs (the session engine) — constants and input cleaning

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 161 | MAX_RUNNING 6 agents at once, MAX_JOBS 40, MAX_LOG 400 (SHOWN_LOG 150), NEED_WAIT_MS 170 s, SIGN_IN_AGAIN_SHARED_MS 30 s, SIGN_IN_CHECK_MS 10 s, RECOVER_WAITS_MS [0, 8000, 20000], STEP_POLL_MS 1 s, PRIORITY survey 0 < recall 1 < import 2 < memory 3 < redact 4 | session.cjs:62-84 | SessionModel.swift | done (cloud) |
| 162 | CONNECT_MODELS pinned: anthropic sonnet high, openai sol high; connectChoice takes the model id/name from Build's list else FALLBACK_IDS (claude-sonnet-5-5 Sonnet, gpt-6.1-sol Sol); unknown provider → anthropic | :89-114 | SessionModel.swift | done (cloud) |
| 163 | promptOf(dataRoot, file, builtIn): `<dataRoot>/.context/<file>` overrides when non-empty | :97-100 | SessionModel.swift | done (cloud) |
| 164 | cleanProject (name ≤200, description ≤4000, both empty → nil); projectFor only with a description | :116-133 | SessionModel.swift | done (cloud) |
| 165 | memoryJobs: imports (label, status, notes, items, said, titles ≤40) and done surveys, never an email job (Gmail) | :143-149 | SessionModel.swift | done: compiled, untested |
| 166 | cleanDirect: mode auto/manual; projects ≤8 (id ≤64 or project-N, title ≤120, description ≤400, folder only inside home); apps ∈ CATALOG unique; scopes per app (kind, folders ≤12 inside home {path,name}, people ≤20, items ≤40, labels ≤40, projects ≤8, note ≤2000); additional ≤12 {name ≤60, website http(s) ≤300, note ≤600, projects}; none → nil; roles ∈ ROLE_NAMES ≤8; work ≤2000 | :158-191 | SessionModel.swift | done (cloud) |
| 167 | directInput: catalog apps → sources on (SITES → sites, Folders on this Mac → code folders, GitHub → code, else group app; PDFs folders), additional turns sites on, picked folders, project = titles joined (≤200) + "title: description" lines (≤4000) | :199-223 | SessionModel.swift | done (cloud) |
| 168 | toolSaid (name (website): note; only for these of the projects: …) and librarianNotes (roles, work, per-source said lines, other tools) exact wording | :231-258 | SessionModel.swift | done (cloud) |
| 169 | cleanChoices: per source apps ∈ source, folders (~ expanded, inside home, ≤12), repos owner/name ≤100; computer = computer ≠ false and files ≠ false; picked only among chosen folders ≤40; custom ≤4000; permissions {files, browser ≠ false, recall ≠ false, notes === true}; project; days; direct; keychain ≠ false; browserAgents; extras | :265-298 | SessionModel.swift | done (cloud) |
| 170 | cleanExtras (≤12 {name, website, note, projects}); cleanBrowserAgents ({browserId `^[a-z]{2,20}$`, browserName sanitized ≤40 or 'your browser', enable}) | :301-318 | SessionModel.swift | partial: cleanExtras cloud-tested (through cleanDirect); cleanBrowserAgents compiled, untested |
| 171 | browseApp(s, app) only with direct + browserAgents + app in s.fallback | :325 | SessionModel.swift | done: compiled, untested |
| 172 | projectBlock `<project note="What the person is working on: …">Name/Description</project>`; periodBlock `<period days="N|all">…</period>` exact text | :328-339 | SessionModel.swift | done (cloud) |
| 173 | detailOf (≤10 non-empty lines folded, ≤600); optionOf (label ≤160, why ≤140, detail, checked for multi, ids ≤200 unique ≤300 chars) | :345-364 | SessionModel.swift | done (cloud) |
| 174 | readReply: JSON (fences tolerated) else {say: clip 2000 or '…', unread}; repos ask (kind repos or code source + REPOS_ASK title); ask kinds single/multi/open (options unique ≤10, source valid, apps within source, placeholder ≤120 for open); authorize/connect kinds signin (Zotero/GitHub) / connector / permission (automation) / folder (local) with default labels; dispatch ≤6 entries of sources that are on with plan (apps ≤8, label ≤80, plan ≤8000); waiting only without ask/authorize; done | :370-402 | SessionModel.swift | done (cloud) |
| 175 | readSurvey: {signedIn, summary ≤600, total, items ≤40 (id ≤300, label ≤160, kind ≤20, date, where ≤120, why ≤120), notes ≤600, folders (folder + folders, inside home, existing, ≤12), searched ≤300}; non-JSON → summary | :408-424 | SessionModel.swift | done (cloud) |
| 176 | messageOf (what the librarian is told: skipped…, Import now., picked "…", and said: …, allowed/signed in/authorized "app", chose kind "shown" for "app", survey finished: "…") and shownOf (what the chat shows) exact | :427-447 | SessionModel.swift | done (cloud) |

## connect/session.cjs — snapshot, persistence, librarian, queue, surveys

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 177 | snapshot(s) fields: id, mode, chat, thinking, activity, waiting, done, error, finished, stopped, minimized, dismissed, jobs (no redact; public fields + route), needs (open; id, app, kind, reason, jobs count, jobIds, opened, busy, browser = need.browser / own / opensIn for sign-in kinds / chosen browser, error, note, at, own, code, where for signin-here), log (last 150), provider, choice {provider, name, modelName, effort}, permissions, projectId, workspaceId, staged, memory, created, counts {notes, items}, placed {project, workspace}, leftOut [{app, why}], blocked {provider, name, error, at}, direct {mode, projects titles}, manual, holding | session.cjs:460-500 | Session*.swift | done (cloud) |
| 178 | save: `<dataRoot>/.connect/<id>/session.json` (0600, dir 0700) = snapshot + full log, choices, picked, found, interviewSession, skipped, skippedSources, suspended, allowed, approved, gmailThreads, fallback, connected, rows, inProject, inWorkspace, workspaceId, jobs with key/plan/titles/find/extra; not while suspended unless forced | :504-514 | Session*.swift | done (cloud) |
| 179 | emit: suspended → nothing; immediate = save + notify; soon = coalesced notify within 250 ms (event `engelbart:connect`) | :517-526 | Session*.swift | done (cloud) |
| 180 | logAction {at, job, who (job label / Engelbart / You), text ≤200}; ≤400 kept | :529-533 | Session*.swift | done (cloud) |
| 181 | get(id) needs a UUID of an open session else "That import is no longer open" | :535-539 | Session*.swift | done (cloud) |
| 182 | accessOf(s): folder guard with picked folders + Obsidian vaults (Obsidian or sites on) + ~/Documents/Zoom (Zoom on) | :546-553 | Session*.swift | done: compiled, untested |
| 183 | dirsOf(s): home when computer allowed; readable source folders, vaults, ~/.claude/projects, codex sessions, ~/Documents/Zoom, ~/Zotero/storage + Zotero mirror, sites' first two vaults, picked folders/exports, downloads; narrowest set | :560-582 | Session*.swift | done: compiled, untested |
| 184 | libraryCounts {items, notes, papers, repositories, websites} from the library rows' tags | :584-590 | Session*.swift | done: compiled, untested |
| 185 | instructions.md of the data root as <custom_instructions> | :592-594 | Session*.swift | done: compiled, untested |
| 186 | notice(s, text) chat entry {role agent, notice, text} never the last word for questions; lastSaid skips notice/grant/opener | :601-608 | Session*.swift | done: compiled, untested |
| 187 | conversationText (grant lines, notices, librarian/person lines with asked/offered) and importsText (JSON of import/survey jobs) | :610-625 | Session*.swift | done: compiled, untested |
| 188 | engelbartBlock exact text (library path, assets/md, permissions yes/no lines); browserBlock `<browser note="…">{browser, sites}</browser>` | :627-640 | Session*.swift | done: compiled, untested |
| 189 | firstMessage: engelbart, project, choices JSON (sources + customInstructionsForThisImport, permissions, period, days), found, library counts, custom instructions, conversation + imports when again, message; laterMessage: imports when changed, newFound, message | :644-670 | Session*.swift | done: compiled, untested |
| 190 | interviewTurn: thinking on; system = connect-system-prompt.md override or INTERVIEW_SYSTEM_PROMPT; resume session else first message (failed resume starts again with the conversation); apply reply; error text or 'The librarian did not answer.'; after: waiting with survey news → wake; waiting with nothing surveying → nudge ≤2 "Every survey has reported already: what they found is in <found>. Go on." | :673-700 | Session*.swift | done (cloud) |
| 191 | apply(reply): chat entry (say, or '' with ask, 'Starting that now.' with dispatch, else '…'); dispatch imports; done when nothing surveying; waitingForSurvey rule; maybeMemory | :702-708 | Session*.swift | done (cloud) |
| 192 | wake: librarian told "survey finished: "app"" joined by '; ' | :711-716 | Session*.swift | done: compiled, untested |
| 193 | dispatch: skipped source/apps out, mayReach filter, key kind/find:source:apps sorted[:again][:extra] unique, ≤40 jobs, whole source already imported → nil; job fields; trace event; log lines (Will look for your …, Will look through …, Will ask … what it remembers, Queued); pump | :721-737 | Session*.swift | done (cloud) |
| 194 | pump: not when stopped/suspended/blocked; running+waiting < MAX_RUNNING (deps.maxRunning); next queued by priority then seq | :739-748 | Session*.swift | done (cloud) |
| 195 | sitesOf(apps); appsOfJob (named apps, else source apps allowed) | :750-753 | Session*.swift | done: compiled, untested |
| 196 | jobMessage per kind (survey: blocks + skills + found + "Look at what they have in X now, and report."; recall: prompt + "Ask X now, and save its answer with save_memory."; import: source JSON, period, plan, chat (clipMiddle 30000), found (clipMiddle 40000), skills, import_instructions, custom, browser block + note for browser route, "Do the import now.") | :755-787 | Session*.swift | done: compiled, untested |
| 197 | findMessage (MATH-117): Zoom/Obsidian/PDFs instructions verbatim, skipped protected folders, look_in tops ≤60, folders_allowed, reply shape | :793-824 | Session*.swift | done: compiled, untested |
| 198 | systemOf(kind): browse (browseSystemPrompt(provider, override connect-browse-system-prompt.md)), survey, recall, memory, redact, import (override connect-import-system-prompt.md) | :826-833 | Session*.swift | done: compiled, untested |
| 199 | runJob: running + log (Writing MEMORY.md / Taking any secrets out of MEMORY.md / Started); browse route; covered apps; page only with browser permission + sites (recall sendOnly); toolNames; session facade (readable, approvedFor, days, gmailThreads persisted); import tools with needs/recall/asked/kept/log/added callbacks; connectors for the run (serversForRun); bridge; memory/redact messages and dirs; result handling (survey → surveyed, memory → drafted, redact → finishMemory); summary ≤500; done log lines (Finished: …, Looked: …, Looked for it: …, Kept what it remembers); failure → holdForProvider or failed/stopped with error ≤300 (survey reported failed; memory status failed/stopped); finally: bridge closed, browser window closed, needs released, rerunJob, pump, maybeMemory | :835-923 | Session*.swift | done (cloud) |
| 200 | rerunJob: an import whose connector was signed in mid-run runs once more (key :again), log "Again, now that X is/are connected" | :930-937 | Session*.swift | done: compiled, untested |
| 201 | holdForProvider (direct runs only): job queued again, s.blocked {provider, error ≤200, at}, log "Waiting for <Provider>: <error>", providerCheck(provider) | :946-958 | Session*.swift | done (cloud) |
| 202 | unblock(id, provider): want ready else "<Provider> is not connected yet"; switching logs "Switched to X (model · effort)" by You; redactChoice dropped if other; "X connected: going on"; pump, maybeMemory | :962-978 | Session*.swift | done (cloud) |
| 203 | surveyed: report into found[source][app].survey and newFound; surveyNews; wake if waiting | :983-991 | Session*.swift | done: compiled, untested |
| 204 | lookedFor (MATH-117): readable folders only; found → picked folder (PDF extra folders ≤12), log "Found your X at …", rescan; none → needs folder with searched text (+Zoom cloud line); dirs recomputed; wake | :998-1023 | Session*.swift | done: compiled, untested |
| 205 | lookForFolders: computer allowed; Obsidian/Zoom/PDFs needing a folder, ticked, not skipped, not picked, not looked for → find survey "Looking for your X" | :1029-1045 | Session*.swift | done: compiled, untested |
| 206 | startWork: web apps (no browser permission → left; held → held entry 'waiting: not signed in yet'; else survey "Looking through X"); connectors (fallback → fallback entry; connected → survey; else Connect card held with connector entry text; no connectors → needs connector); recalls for memory chat apps when recall+browser allowed (held apps get recall flag) | :1051-1093 | Session*.swift | done (cloud) |
| 207 | releaseHeld(app, how): skip/stopped → skipped entry + wake; direct → directImport (+recall); else survey (or 'not run: Import was pressed first') + recall | :1096-1120 | Session*.swift | done: compiled, untested |
| 208 | checkedAs (signed-in keeps earlier browser/profile, unchecked; refused; no-browser; held-elsewhere; signed-out) | :1127-1137 | Session*.swift | done: compiled, untested |
| 209 | signInNote / profilesToAsk / signInPick / signInCheck (one check per app at a time, retry forgets the refusal, kept per app) / signInWindowOpen (signed in counts for every app sharing the sign-in; ends a wait in the browser) / signsInAtAll | :1145-1226 | Session*.swift | done: compiled, untested |

## connect/session.cjs — sign-ins, needs, recovery, memory, start, direct, controls, resume

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 210 | signInBrowser (one wait per sign-in group, no time limit; signed-in/denied/no-browser/cancelled; signed in or refused kept for every app sharing it), signInUnlock (macOS asked now, refused → all sharing refused), signInAnotherAccount, signInBrowserCancel, signInWindowClose | session.cjs:1232-1299 | Session*.swift | done: compiled, untested |
| 211 | signInsFirst: web apps ticked, reachable, signable; keychain declined → only Engelbart's own sign-in counts ("Signed in to X already"); kept answers reused, checks in progress awaited, others copied quietly together up to 10 s (deps.signInCheckMs); unanswered → checking; logs "Signed in to X from B" / "already" / "Couldn't check the X sign-in (no answer): counted as signed in" | :1309-1360 | Session*.swift | done (cloud) |
| 212 | lateSignIn: "Still checking the X sign-in"; signed in → release held; refused → left out + skipped + notice skippedLine; held-elsewhere → heldElsewhere; signed out → recoverHeld | :1367-1392 | Session*.swift | done: compiled, untested |
| 213 | listed (A, B and C), byBrowser, skippedLine "Skipped X: macOS didn't allow B's sign-ins. You can add it/them later from Add sources.", leftOutLine, signInLines "Using your B sign-ins for X.", noteFor (keychain note for sign-in/password cards) | :1395-1427 | Session*.swift | done (cloud) |
| 214 | needApp: an Other tool's own name; a web first app; a web app whose site the reason names (word edges); another app named outright (longest name); else first app or label | :1436-1455 | Session*.swift | done: compiled, untested |
| 215 | ownStatus / isConnectorApp / connectorConnected / checkConnectors | :1465-1479 | Session*.swift | done: compiled, untested |
| 216 | connectorFallback: unavailable connector → website via toolJob (plan text) or, without a website, left out + notice "Couldn't connect to X. Skipped." | :1486-1501 | Session*.swift | done: compiled, untested |
| 217 | watchStep: Zotero/GitHub/connector steps polled every 1 s (deps.stepPollMs); signed in → "Signed in to X" by You + closed done; device code shown (need.code); sign-in error shown and step reopened | :1504-1527 | Session*.swift | done: compiled, untested |
| 218 | leaveOut (first reason holds), laterWhy per kind (permission / consent / connector / confirm / sign-in) | :1530-1543 | Session*.swift | done: compiled, untested |
| 219 | askPerson: skipped app → skipped note; Zotero/GitHub kind signin, connected → done note; connector connected after start → rerun + done note; browser route → askInBrowser; web sign-in → signInAgain; Other tool sign-in → recover; else one need per app+kind ("Needs you: <reason>", trace), watchStep, waitOn | :1546-1580 | Session*.swift | done: compiled, untested |
| 220 | askInBrowser: own need with note "<What> on its tab in <Browser>, then press Done. The agent never types a password." | :1587-1600 | Session*.swift | done: compiled, untested |
| 221 | signInAgain: shared check per group within 30 s; same agent asking again after "still signed in" → skipped note; check stands → done note "Still signed in…"; else recover | :1613-1645 | Session*.swift | done: compiled, untested |
| 222 | recover (M5): quiet copies at 0/8/20 s (deps.recoverWaitsMs; keychain declined → none; refused/held/needs/declined stop), then one card SIGNIN_HERE "Sign in to X" (Sign in inside Engelbart · Skip); back → "The X sign-in works in Engelbart's browser again. Reload the page and carry on."; ended recovery asked again by the same agent after a card → given up; held apps (no job) wait on the card's settle | :1650-1765 | Session*.swift | done (cloud) |
| 223 | giveUp: notice "Couldn't connect to X. Skipped." + log; close card skip "Engelbart couldn’t connect to it" or leave out + skip | :1768-1778 | Session*.swift | done: compiled, untested |
| 224 | recoverHeld / heldElsewhere (browser agents → readElsewhere; sign-in window → recover; else read elsewhere/skip) | :1781-1803 | Session*.swift | done: compiled, untested |
| 225 | signInHere / signInHereNow: busy while the window is open; registered app → signInWindowOpen, tool → openSite; works (signed in and stillSignedIn) → "Signed in to X inside Engelbart" + done; rejected/refused/signed-in-but-not-working or 2 tries → giveUp; else error "Not signed in to X yet." | :1803-1842 | Session*.swift | done (cloud) |
| 226 | waitOn: job waiting; 170 s → running again with note "The person has not done it yet. Call wait_for_you again, or go on without it and say so."; waitAgain ("Nothing is waiting on the person any more.") | :1844-1858 | Session*.swift | done: compiled, untested |
| 227 | closeNeed: skip → leftOut + skipApp (+ apps sharing a recovery's sign-in); settle; held → releaseHeld; connector done → rerun imports + note; waiters resolved; agent windows hidden; log "Skipped: …"/"Done: …" by You | :1864-1888 | Session*.swift | done (cloud) |
| 228 | skipApp (jobs of only skipped apps stopped/aborted as skipped; found note), skipAsked (last button's app, the ask's apps, or its source), skipSource, releaseNeeds (a need no job waits on closes, unless keep) | :1895-1957 | Session*.swift | done (cloud) |
| 229 | keepRecall: `<session>/memories/<App>.md` (0600); maybeMemory (done or finished, direct waits for held, all work ended, something worked else memory skipped) → memory job; memoryMessage (existing memory, assistant memories (recalls clip 12000 + local memories), conversation clip 20000, imports JSON, custom, import instructions, folders, "Today is <date>. Write MEMORY.md now."); drafted (fences stripped, <40 chars → "The memory agent wrote nothing to keep", redact on Claude Code Sonnet when ready else session's); finishMemory (< half the draft → draft kept + log, scrubSecrets, saveMemory, memory saved {path, previous, removed, at}, log "Saved MEMORY.md (N more secret(s) masked)") | :1961-2025 | Session*.swift | done (cloud) |
| 230 | rescan(sources): survey results and searched kept; dirs; lookForFolders | :2029-2045 | Session*.swift | done: compiled, untested |
| 231 | start(input): directInput; cleanChoices; librarian:true + direct → manual librarian run (custom = notes, sites only when Saved URLs picked, extras); "Pick at least one source."; no CLI → direct waits (blocked "<P> is not connected") else "Sign in to Claude Code or Codex first: the agents run on one of them."; provider = asked if ready else first ready; browser agents from browserAgents.status; projectId/workspaceId validated; session fields; scoped folders picked; log "Started with <P> (<model> · <effort>)"; trace; opening | :2048-2097 | Session*.swift | done (cloud) |
| 232 | opening (librarian): opener "Looking at what you picked…"; deps.allowed; askGrant; scan; foundSentence; markAsking; wait for grant; beginApps; lookForFolders; sign-in lines appended; first turn "Start." | :2102-2127 | Session*.swift | done (cloud) |
| 233 | afterGrant; askedApps (web/connector ticked, not skipped); mayReach (direct, or not asked-first, or allowed); pickedHere | :2133-2154 | Session*.swift | done (cloud) |
| 234 | askGrant (one chat message with grant rows {id, name, tool, website}, apps held with consent, log "Asking you: Allow Engelbart to access …?"), markAsking (consent text), granted/releaseGrant, grant(id, {apps}) ("Pick at least one app"), answerGrant (allowed/skipped names, left out "you didn’t allow Engelbart to access it"), allowOne (tool → extraImport) | :2166-2234 | Session*.swift | done (cloud) |
| 235 | extraImport + toolJob (copy the tool's sign-in → "Copied your X sign-in"; else browser agents route; label "Other tools: X" ≤120; extra {sites, tool}; keyExtra name) | :2241-2263 | Session*.swift | done: compiled, untested |
| 236 | beginApps: checkConnectors, signInsFirst, startWork with held, lateSignIn, recoverHeld for signed out, refused skipped "Skipped X: macOS didn't allow B's sign-ins" | :2270-2289 | Session*.swift | done (cloud) |
| 237 | directOpening: opener "Bringing in what pertains to <titles>…" / "Bringing in what you picked…"; scan; connectors reached (own included) "Using your X connection(s)"; signInsFirst; keychain declined + browser agents → elsewhere; no agents + window → signed out; refused left out/skipped; elsewhere → readElsewhere; fallback log; own sign-in / connector held cards; connectorFallback; directImport per app; lateSignIn; extra tools via toolJob with plan; recalls (not for fallback apps not signed in); opener text = foundSentence without "Starting with…" + sign-in lines + "Waiting for you to sign in to X."; done and finished; maybeMemory | :2303-2398 | Session*.swift | done (cloud) |
| 238 | directImport: Saved URLs → "Pages from your browser history"; Folders on this Mac → code with "The folders: …"; GitHub; else "<Group label>: <App>" with plan (PDFs folders), browser route | :2401-2414 | Session*.swift | done: compiled, untested |
| 239 | readElsewhere: browser agents → fallback + log; else left out + skip + notice "Left out X: you're signed in to it in B, but it doesn't let Engelbart use that sign-in." | :2421-2433 | Session*.swift | done: compiled, untested |
| 240 | signInCard (direct): one card per app+kind, reason "Connect X so its agent…" / "Sign in to X so its agent…", held, watchStep | :2441-2451 | Session*.swift | done (cloud) |
| 241 | foundSentence: "Found N Obsidian vaults, N PDFs (from period) in A and B, your X chats, N X items and N X repositories. Starting with your <first source>." or "Had a look at what you picked." | :2454-2478 | Session*.swift | done: compiled, untested |
| 242 | answer(id, {text|picked|skipped, provider}): busy → "Wait for the librarian to answer"; picked ≤12; text ≤4000; empty → "Say something first"; setProvider; skipAsked; approvePicked; chat user entry; librarian turn | :2480-2497 | Session*.swift | done (cloud) |
| 243 | approvePicked (APPROVAL_APPS items by survey ids or same label), setProvider ("<P> is not signed in"; new librarian session; log) | :2506-2538 | Session*.swift | done: compiled, untested |
| 244 | authorize(id, {app, kind, path}): connector sign-in (activity "Waiting for you to sign in to X in your browser") then survey; permission (Apple Notes) sets notes permission; signin; folder/file inside home ("Choose something inside your home folder") picked; chat + log; Zotero waits ≤90 s for items.json ("Waiting for your Zotero library to sync"); rescan; librarian turn | :2545-2603 | Session*.swift | done (cloud) |
| 245 | importNow: finished; open grant answered "you pressed Import before allowing it"; each source not yet sent → import with default plan text verbatim; chat "Import now"; done; maybeMemory | :2609-2639 | Session*.swift | done (cloud) |
| 246 | need(id, needId, open/done/skip): signin-here (skip / signInHere); Zotero/GitHub own sign-in (open → ownSignIn; done checks "Still not signed in to X."); sign-in done → signedInNow; confirm; own browser → openBrowserApp ("Open B yourself: the agent's tab is there."); connector sign-in in background (cancel on Later; errors shown); Apple Notes permission; other permission done; keychain declined → readElsewhere/skip; unknown-cookie app → openApp ("Couldn't open X. Open it in your browser, then come back."); web sign-in via webSignIn.signIn (statuses signed-in, held-elsewhere, unsupported/no-browser, denied, timeout texts); else "Open X in your browser to finish this, then come back." | :2644-2762 | Session*.swift | done (cloud) |
| 247 | signedInNow ("I'm signed in"): ends Open's wait, signInQuiet or copyBlind, signed in → done; held → readElsewhere; refused → skip + notice; opened + agents → readElsewhere; else "Still not signed in to X (in B)." | :2768-2793 | Session*.swift | done: compiled, untested |
| 248 | ownSignIn: Zotero/GitHub connect() (connected → done; failure text; pending → opened with device code, watchStep) | :2802-2826 | Session*.swift | done: compiled, untested |
| 249 | showWindow / logJob / windowClosed (sign-in kept only when Engelbart's browser holds it, else "Not signed in to X yet.") | :2832-2869 | Session*.swift | done: compiled, untested |
| 250 | stopJob (queued → stopped; running aborted), stop (all aborted, queued stopped, needs skipped, grant released, memory stopped, "Stopped everything"), retryMemory ("This import was stopped"; redact again when a draft is kept), setMinimized, dismiss | :2871-2915 | Session*.swift | done (cloud) |
| 251 | attachProject: staged notes flushed into the project, workspace kept, rows placed | :2918-2928 | Session*.swift | done: compiled, untested |
| 252 | keepRow / placeRows: rows kept on the project's list (never removed ones); onboarding runs also link to the Welcome workspace; placed(projectId) | :2937-2965 | Session*.swift | done: compiled, untested |
| 253 | suspendAll: unfinished sessions saved suspended (forced), agents aborted, grant released, sessions dropped, browser windows closed | :2973-2987 | Session*.swift | done (cloud) |
| 254 | unfinished(saved) (≤7 days, not stopped/dismissed; blocked/stalled; not done; work unended; memory pending), stalledOnProvider | :3001-3022 | Session*.swift | done (cloud) |
| 255 | revive: cleaned choices, kept paths/recalls/tools, chat (opener only → empty), jobs requeued (memory jobs only if saved), held surveys requeued, blocked kept while no CLI, direct needs rebuilt (connected → import; web → recoverHeld; else card), grant reopened/asked, connectors allowed but not connected → card or survey; log "Picked up again after Engelbart closed"; restart opening / directOpening / afterGrant / interview turn with the exact catch-up messages | :3046-3175 | Session*.swift | done (cloud) |
| 256 | resume(ctx) once per data root; list(dataRoot) newest first; providers(); cancelSignIn; forget(dataRoot) (sessions stopped, sign-in answers forgotten); setProvider; connected alias; state; has | :3184-3245 | Session*.swift | done (cloud) |

## connect/tools.cjs (the import agents' tools, the `engelbart` MCP server)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 257 | IMPORT_TOOLS: 42 tools with exact names, descriptions and JSON schemas (additionalProperties false); limits 300 files, 100 chats, 300 Zotero, 200 PDFs, 80 checks, 25 Google, 40 web chats, call budget 170 s, note ≤200000 chars, Gmail page ≤5 MB | tools.cjs:27-96 | Tools.swift | done (cloud) |
| 258 | TOOLS_FOR per kind (survey LOOK, recall, import (all but save_memory), discover, browse); WRITING set; BROWSING set; FIXED_READER_APPS ChatGPT/Claude/Overleaf/Gmail; APPROVAL_APPS Google Docs/Google Meet/Overleaf | :102-131 | Tools.swift | done (cloud) |
| 259 | browsedApps, BROWSE_SITES / SURVEY_SITES (Drive surveys stay on drive.google.com), recalledApps, browseSitesFor, toolNamesFor (browser tools only when a page and something browsed), toolsFor | :137-170 | Tools.swift | done (cloud) |
| 260 | validateImportTool: unknown tool; required; unknown argument; arrays of text / objects of text (no NUL, ≤4096); numbers finite; strings typed; strings ≤4096 except markdown/script/text | :173-191 | Tools.swift | done (cloud) |
| 261 | imported.json per data root (`.connect/imported.json`, 0600): keys file:, note:, chat:App:id, google:, gmail:ik:id, overleaf:, apple-notes:, zotero: — second import skipped | :193-210 | Tools.swift | done (cloud) |
| 262 | chatNote (`*App · date · project*`, **You:** / **<App or Claude>:** turns, clipMiddle 200000); googleMarkdown (data: images written, ![][label] linked); csvTable (≤200 rows, ≤20 columns, pipes escaped) | :213-256 | Tools.swift | done (cloud) |
| 263 | Session facade: library switched mid-run → "Engelbart switched to another library while this import ran; it stopped."; where() (absolute or ~/, inside home, readable else "macOS has not let Engelbart read X: leave it out, and say so in your reply."); exports ("There is no X export on this Mac; use web_chats for X."); browser missing ("Engelbart's browser is not available to this agent. Say so in your reply."); browsing() host check with fixed-reader message | :300-345 | Tools.swift | done (cloud) |
| 264 | within(days): the session period caps longer asks; knows(app, more) {source, category, itemDate, originUrl, place, messages}; dayOf; placeOf (vault/sub/folder) | :312-368 | Tools.swift | done: compiled, untested |
| 265 | putNote → Markdown copy + kept + imported + added('notes'); addRow → addItem (EXISTS → already, kept); addFile copies pdf/images else addRow; unzipInto with safe names | :371-421 | Tools.swift | done (cloud) |
| 266 | folder_overview, list_note_files (≤2000 + more), import_note_files (per-file skip reasons: brought in before, not a note file, not there, larger than 5 MB, not a file; log "Brought in N note(s)"; answer with where text) | :430-454 | Tools.swift | done (cloud) |
| 267 | add_note (≤200000, note:<source> key, log "Wrote “title”"), add_to_library, list_pdfs (+check via inspectPdf ≤80 within half the budget), import_pdfs (budget, left), unpack (.zip only, overview) | :455-506 | Tools.swift | done (cloud) |
| 268 | list_chats (CHAT_APPS check, cap 1000, imported flag), read_chat (clipMiddle 500..40000), import_chats (skip reasons, chatNote, knows itemDate/place/messages) | :507-534 | Tools.swift | done (cloud) |
| 269 | web_chats / web_chat_read / import_web_chats (budget, SIGNED_OUT stops the call) | :535-562 | Tools.swift | done: compiled, untested |
| 270 | browser_* tools through browsing(); browser_screenshot as MCP image content; browser_download into imports/<session>/files | :563-575 | Tools.swift | done: compiled, untested |
| 271 | import_google_files: id/approval/kind checks; Docs export md (googleMarkdown), Sheets csv (csvTable), Slides txt; files via uc?export=download then drive.usercontent confirm; signed-out pages detected; note header `*Google Drive · https://drive.google.com/open?id=<id>*` | :576-638 | Tools.swift | done (cloud) |
| 272 | gmail_accounts (u/0..5 until a sign-in page, a different place, or the same account), gmail_search (non-empty words, "(words) newer_than", cap 50, imported flag), import_gmail_threads (session cap 300, print view download, thread checks, note) | :639-709 | Tools.swift | done: compiled, untested |
| 273 | overleaf_projects (ol-prefetchedProjectsBlob or links, signed-out detection) and import_overleaf_projects (≤20, zip magic check, unzip, folder row "(Overleaf)", main.tex note in a latex fence, ≤3 pdfs) | :710-758 | Tools.swift | done (cloud) |
| 274 | apple_notes_folders / apple_notes_list / import_apple_notes (≤200, imported skip count) | :759-773 | Tools.swift | done (cloud) |
| 275 | browser_history (profileOf, days within 90, by, exclude, limit ≤500), browser_bookmarks, links_in_notes (≤1000) | :774-786 | Tools.swift | done (cloud) |
| 276 | zotero_collections / zotero_items / import_zotero_items (pdf in place or downloaded, DOI, link; collections place; year date); zoteroRoot waits ≤180 s for the first sync with exact messages | :787-822,881-913 | Tools.swift | done (cloud) |
| 277 | github_repos ("GitHub is not signed in. Call needs_you…"), needs_you (kinds; reason ≤160), wait_for_you ("Nothing is waiting on the person."), save_memory (≥20 chars; log "Kept what X remembers (N characters)"; the question's chat deleted) | :823-848 | Tools.swift | done (cloud) |
| 278 | Recall's question chat noted from the page address after a send (type+submit, Enter, click) and deleted once the answer is kept; logs "Deleted the question from X's chats" / "Couldn't delete …" | :855-875 | Tools.swift | done: compiled, untested |
| 279 | callTool: validate; not allowed → "A survey brings nothing in: report what you found instead." or "<name> is not one of this agent's tools" | :915-924 | Tools.swift | done (cloud) |
| 280 | findMainTex: main.tex first, the one with \documentclass | :928-933 | Tools.swift | done (cloud) |

## connect/web-signin.cjs (sign-ins copied from the person's browser)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 281 | SIGN_IN_PAGES (ChatGPT /auth/login, Claude /login, Google group accounts.google.com, Overleaf /login); BROWSER_NAMES → importer ids (chromium, canary none, chrome, brave, edge, vivaldi, opera, arc, comet, dia, firefox, technology preview none, safari); ANOTHER_ACCOUNT_PAGE; polls 4 s for 2 min then 15 s; timeout 5 min; held wait 2 min; check answers kept 3 min per site | web-signin.cjs:57-87 | WebSignIn.swift | done (cloud) |
| 282 | domainsOf(app) (cookie's domain first, then registrable of its sites); registrable(domains); profileOpenArgs (`open -n -b <bundle> --args --profile-directory=<id> <url>`) | :90-128 | WebSignIn.swift | done (cloud) |
| 283 | supports (importer + known cookie + web or connector with sites), canSignIn, signedInHere/isHere (window sign-ins never copied over again), copies | :156-168 | WebSignIn.swift | done (cloud) |
| 284 | signedIn(app) by the sign-in cookie in Engelbart's store; works via checkSite (cached 3 min; detail logged "Checked the X sign-in (status → location): signed in/out." / "No answer checking … counted as signed in.") | :171-210 | WebSignIn.swift | done (cloud) |
| 285 | snapshot/undo (C3: every cookie a failed copy wrote removed, overwritten ones restored); stillSignedIn; drop; live | :213-275 | WebSignIn.swift | done (cloud) |
| 286 | One browser and profile (C4): chosen browser else default by name; profile = remembered, else picked for the sign-in, else Default, else first; readable/openable (installed Chromium with no profile yet) | :277-323 | WebSignIn.swift | done (cloud) |
| 287 | printOf/holding/holders (cookie names + stamps, no Keychain); picked/choose (signin-profiles.json keyed by cookie site); holdersOf (keychain flag when not asked) | :325-373 | WebSignIn.swift | done (cloud) |
| 288 | openers (chosen browser only), installedNow (importer ready ≤2 s), openPage (profile when >1 profiles, default via openExternal, others via openIn), openApp | :376-424 | WebSignIn.swift | done (cloud) |
| 289 | copyBlind / copyDomains / copyFor (declined, noBrowser, needs disk-access / keychain, refused; quiet import one browser at a time; checked sites; signed out → undone; nothing copied and nothing held → signedIn false) | :427-493 | WebSignIn.swift | done (cloud) |
| 290 | heldThere (Google group signed in there), openFirst, opensIn | :496-528 | WebSignIn.swift | done (cloud) |
| 291 | bringOver (declined; disk-access; holder check; refused; askedOnly passes over unasked Chromium unless allowed; seen prints skip unchanged profiles (C8); copy then signedIn+works; dead → undo) | :531-578 | WebSignIn.swift | done (cloud) |
| 292 | signIn (live → signed in; unsupported; no-browser; first copy; denied; needs-disk-access; declined; held-elsewhere; page opened in chosen browser; waitFor until copied, cancelled, here, or timeout) | :593-632 | WebSignIn.swift | done (cloud) |
| 293 | waitFor (fast then slow polls, cancelled, here, stop) | :638-651 | WebSignIn.swift | done (cloud) |
| 294 | signInQuiet (here/off-Mac: own session only, fresh drops; fresh drop + copy; live; noBrowser; bringOver; needs; declined; refused; held) | :666-692 | WebSignIn.swift | done (cloud) |
| 295 | recapture (app: copy at once else open page and wait, held → 2 min, turned-away; tool sites: copyFor, print change triggers copy) with reasons | :699-784 | WebSignIn.swift | done (cloud) |
| 296 | anotherAccount (Google AddSession in the waiting browser), unlock (keychainTarget asked now; denied), unlockBrowser (Safari needs disk access; Chromium unlock; refusedHere), profilesOf (>1 unlocked profiles), keychainTarget/keychainNote "macOS will ask to use B's sign-ins. Choose Allow.", forget | :787-886 | WebSignIn.swift | done (cloud) |
| 297 | Cookie import itself (Chromium Keychain decryption, Firefox, Safari binarycookies, check pages) is the Stage's (main/browser/import-cookies.cjs): consumed through the `CookieImporter` protocol | browser/import-cookies.cjs | API.md Needs | n/a: owned by the Stage package (main/browser/**) |

## connect/prompts.cjs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 298 | Every prompt verbatim (INTERVIEW, IMPORT, BROWSE + RULES/CLAUDE/CODEX, SURVEY, RECALL_PROMPT, RECALL, MEMORY, REDACT); browseSystemPrompt(provider, base) = base + "\n\n" + Codex or Claude browser block | prompts.cjs | Texts.generated.swift, Session*.swift | done (cloud): generated verbatim from prompts.cjs by scripts/gen-texts.cjs; the rules tests read (options, detail, browse rules, Google Drive) asserted |

## onboarding/ (Import your context backend)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 299 | prefs: `<dataRoot>/.connect/onboarding.json` {provider, browser, profile, keychain, browserAgents, flow ≤200000 bytes} cleaned on read/write; set(patch) with null removing; atomic write 0600 + newline | onboarding/prefs.cjs | BrowserAgents.swift | done (cloud) |
| 300 | disk-access: granted when TCC.db (~/Library/Application Support/com.apple.TCC/TCC.db) opens; ENOENT unknown → not granted; off-Mac granted; ENGELBART_DISK_ACCESS fake; open() opens `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` with /usr/bin/open | onboarding/disk-access.cjs | Onboarding.swift | done (cloud) |
| 301 | providers: Claude Code `auth status --json` (loggedIn, subscriptionType when authMethod claude.ai), Codex auth.json id_token plan (chatgpt_plan_type paid regex), codexSignedIn, since = folder birth time, state words (connecting / signing-in / ready / not-connected), works = ready/updating/outdated+autoUpdate, outdated/incompatible asked too; 60 s cache; remember; recheck; ready; ENGELBART_PROVIDERS_FAKE both/claude/codex/free/none | onboarding/providers.cjs | Onboarding.swift | done (cloud) |
| 302 | browsers: installed supported browsers (2.5 s settle), default first, chosen = remembered if installed else first; profiles; chosenProfile; keychain; safari.diskAccess; choose (forgets another browser's profile; "X is not installed"); chooseProfile ("X has no such profile"); setKeychain (declined at once; allowed → unlock chosen → allowed/refused (+needs)); preferredName; ENGELBART_ONBOARDING_BROWSERS override | onboarding/browsers.cjs | Onboarding.swift | done (cloud) |
| 303 | browser-agents: extensions (Claude fcoeoabgfenejglbffodgkkbkcdhcgfn; Codex ids or chrome-native-hosts-v2.json) + native messaging host per browser profile roots; Codex chrome plugin cache; allowedByCli (claudeInChromeDefaultEnabled; codex features.browser_use ≠ false and chrome@openai-bundled ≠ false); status {available, provider, browser, others, allowedByCli, consent, ask, use, why}; a "no" wins; consent(answer) kept; readCodexConfig (features, plugins, servers); ENGELBART_BROWSER_AGENTS fake | onboarding/browser-agents.cjs | BrowserAgents.swift | done (cloud) |
| 304 | digest: projectDigest (Claude Code/Codex sessions 120 days grouped by folder: sessions, last day, apps, repository, titles ≤10; ≤25 folders) + recentRepos (home ≤3 deep, guarded folders only when readable, .git logs/HEAD/index/HEAD stamp within 120 days, README first line ≤120, ≤15) + existing projects ≤30; digestEmpty | onboarding/digest.cjs | Discovery.swift | done (cloud) |
| 305 | obsidian-tree: vaults as Obsidian's explorer (folders first, files shown .md/.canvas/.pdf/images/.txt/.csv, numeric case-insensitive sort, notes without .md, dot folders and node_modules hidden, ≤5000 entries, depth ≤10, truncated) | onboarding/obsidian-tree.cjs | Onboarding.swift | done (cloud) |
| 306 | discover: state per data root in `.connect/discovery.json` (running/checking settle to stale); provider(asked) ready-only, else connect; failure → connect when needsProvider (+ providers.recheck) | onboarding/discover.cjs:184-235 | Discovery.swift | done (cloud) |
| 307 | startProjects: waiting-provider; reuse running/done; digest (scanner); agent on the digest (kind projects, PROJECTS_SYSTEM_PROMPT, message with recent_work, Today, ask) → readAnswer; found → done from [CLI]; else assistants (keychain answer waited ≤10 min; declined/unanswered → none) in provider order; merged projects; broke → failed (keeps earlier projects); none → done empty no-context with asked outcomes | onboarding/discover.cjs:243-312 | Discovery.swift | done (cloud) |
| 308 | startTools: waiting-provider; reuse; detect (scanner) → toolEvidence (history sites per browser: Chromium profiles ≤4, Firefox places ≤3, Safari only with Full Disk Access; USAGE_SITES; cookie names; ≥3 visits; installed app) shown at once; keychain allowed → web sign-ins copied (20 s each); agent with discover tools over the bridge (catalog, evidence, browser, top sites, categories); readTools; failure keeps evidence with error/connect | onboarding/discover.cjs:66-182,348-433 | Discovery.swift | done (cloud) |
| 309 | stop, reset, forget; notify `engelbart:discovery` | onboarding/discover.cjs:436-462 | Discovery.swift | done (cloud) |
| 310 | assistant-projects: ChatGPT/Claude asked with assistantProjectsPrompt(today) in a hidden window (sendOnly the question): new chat page, sign-in page detection, SIGNED_IN script (retry once), FIND_COMPOSER, type, Send button or Enter, chat id from address (20 s) else found among the 5 newest; answer read until it stands (malformed taken after 4); deleted after; outcomes found/none/unavailable/broke; readAnswer, answerIn, mergeProjects | onboarding/assistant-projects.cjs | Discovery.swift | partial: readAnswer / mergeProjects / answerIn / atSignIn cloud-tested; ask() in a hidden window against the real ChatGPT/Claude untested (no network) |
| 311 | onboarding prompts verbatim (PROJECTS_SYSTEM_PROMPT, TOOLS_SYSTEM_PROMPT, assistantProjectsPrompt(today)) | onboarding/prompts.cjs | Texts.generated.swift, Session*.swift | done (cloud): generated verbatim from onboarding/prompts.cjs; discovery runs on them with the fake agents |
| 312 | trace: entries in `<dataRoot>/.connect/trace/<day>.jsonl` (0600), fields cut at 400000 (middle note), ≤400 in memory, 14 days kept, turn entries (kind, provider, model, effort, label, session/job, dirs ≤40, system, message, output, error, activity ≤300 deduped, browse command/pictures ≤80/transcript ≤200000), events; wrap(agents) | onboarding/trace.cjs | Trace.swift | done (cloud) |
| 313 | Agent trace window: 980×820 (min 560×400) "Agent trace", trace.html shown with traceApi (list, save as HTML via a save panel "Engelbart agent trace <stamp>.html", reveal folder, onEntry) | onboarding/trace-window.cjs, trace.html, trace-preload.cjs | Trace.swift + Resources/trace.html | done (cloud) |

## IPC surface (ipc.cjs, preload.cjs, index.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 314 | connect-* calls map 1:1 onto ConnectEngine methods (detect, providers, start, answer, grant, authorize/chose, cancel-sign-in, signin-note/pick/browser/unlock/another-account/browser-cancel/check/window/window-close, folders-needed/asked/ask, need, import, stop, unblock, stop-job, provider, retry-memory, minimize, dismiss, state, list (resume first), notes-permission, connectors, connector-sign-in/cancel, offer/offer-seen, memory) with the same argument checks (ids ≤64, app ≤64, kind ≤16, path ≤4096, folder ids ≤40 each <400) | ipc.cjs:563-717 | ConnectEngine.swift | done (cloud) |
| 315 | connect-offer: `.connect/offer.json` {seen, how started/dismissed, at}; ENGELBART_CONNECT_OFFER=off never shows | ipc.cjs:648-658 | ConnectEngine.swift | done (cloud) |
| 316 | guided-offer / getting-started: the Store's getting-started module | ipc.cjs:660-669 | API.md Needs | n/a: store/getting-started.cjs belongs to the Store package |
| 317 | import-* calls (providers, provider-remember, browsers, browser-choose, keychain, browser-agents (+answer), discovery, discover-projects/tools, discovery-stop/reset, disk-access, browser-profile, open-disk-access, flow, flow-save, trace-open, obsidian-tree) | ipc.cjs:671-716 | ConnectEngine.swift | done (cloud) |
| 318 | Events: engelbart:connect (snapshot), engelbart:discovery (state), engelbart:connectors (status), engelbart:project-changed {projectId} (placed), trace entries to the trace window | index.cjs:1015-1183 | ConnectEngine.swift | done (cloud) |
| 319 | Fakes: ENGELBART_CONNECT_FAKE / ENGELBART_BART_FAKE (fake agents, delay ENGELBART_CONNECT_FAKE_MS default 700), ENGELBART_CONNECT_FAKE_CLI + tools fake state, ENGELBART_CONNECT_FAKE_REFUSE, ENGELBART_CONNECT_FAKE_NEEDS; providers fake 'both' with connect fake; browser agents 'none' with connect fake; ready() both with connect fake | index.cjs:1003-1149 | ConnectEngine.swift, Fake.swift | done (cloud) |
| 320 | connectSignedIn: apps whose sign-in cookie Engelbart's store holds (detect's signedIn); ENGELBART_CONNECT_APPLICATIONS overrides /Applications | index.cjs:1184-1193, ipc.cjs:574-589 | ConnectEngine.swift | done (cloud) |
| 321 | Disk access granted at launch → every protected folder written as allowed in folders.json; discovery's access guard counts them allowed | index.cjs:1199-1206 | ConnectEngine.swift | done (cloud) |
| 322 | will-quit → suspendAll; afterTestReset → webSignIn.forget (+ the store cleared for an unpackaged copy) | index.cjs:1240-1248 | ConnectEngine.swift | done (cloud) |
| 323 | openBrowserApp(id): `/usr/bin/open -b <bundle>` (Vivaldi `-a Vivaldi`), 10 s | index.cjs:1141-1146 | ConnectEngine.swift | done: compiled, untested |
| 324 | openChosen(url): a connector's consent page opens in the browser chosen for sign-ins (`open -b <bundle> <url>`), else the default | index.cjs:1015,1062-1066 | ConnectEngine.swift | done: compiled, untested |
