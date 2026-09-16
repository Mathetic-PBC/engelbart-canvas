# Engelbart Design System

**Engelbart** — "Tools for steering coding agents." An open-source Claude Code plugin (`/bart`) that gives you and your agent a shared, editable representation of goals and todos. It infers goals from your Claude Code chat, opens a local goal workspace, and injects the goals document back into the chat. It is part of a cognitive-science research effort (berkeley.mathetic.com) into how humans and AI plan and coordinate over long-running work. Early beta.

## Sources

- Codebase (attached, read-only): `claude-plugins/` — mirrors GitHub **https://github.com/divadbaroon/claude-plugins**
  - `hc/src/human_compact/trajectory/web/setup.html` + `setup.js` — the first-project **Setup Wizard** (`hc setup-ui`). Primary source of the visual language.
  - `hc/src/human_compact/trajectory/web/goals.html` — **Vault-goals** cross-chat goal workspace (tree + inspector). Experimental.
  - `hc/src/human_compact/trajectory/web/index.html` — **Trajectory** evidence-cloud graph (sigma.js).
  - `engelbart/` — the installer CLI; `hc/` — Python runtime; `compact-focus/` — sibling plugin.
  - `berkeley-ui/` — Berkeley Research Directory (Berkeley blue/gold). **A different brand** — documented, not systematized here.
  - `design/like/links.md` — points at vercel.com/geist and its Checkbox as the reference aesthetic ("Vercel theme").
- Uploaded: `uploads/Setup Wizard.html` — a bundled interactive prototype of the wizard (template extracted to `research/setup-wizard-source.html`). Its inline values are the ground truth for the components here.

No logo, icon set, or image asset exists anywhere in the sources. Wherever a mark would go, the word **Engelbart** is set in plain type (500 17px, −0.2px tracking).

## Products / surfaces

1. **Setup Wizard** (`/setup`) — 9-step onboarding: name → year → major → explanation level → project → plan → focus → todos → create. Two-pane: 340px rail of steps on `#fafafa`, 600px centered body.
2. **Goal workspace** (`/bart`, Vault-goals) — a dense two-column tool: goal tree on the left, sticky inspector on the right (status/priority chips, PROMPT / NOTES tabs, mono drafts).
3. **Trajectory** — graph view with a right panel and slide-in sheet.

## Content fundamentals

- **Voice: plain, declarative, lower-case-leaning.** Sentences are short and concrete. Headings are questions or terse nouns: "What is your name?", "What do you want to work on?", "Looks good?", "Plan", "Goal", "The project".
- **Second person for the user, first person for the model.** "Here's what I think you're working on." "You're building an agentic coding tool…" The system speaks as a colleague, never as a mascot.
- **Sentence case everywhere in body copy; ALL-CAPS only via tracked micro-labels** (9–10px, 1.2–1.6px letter-spacing): `STEP 1 OF 9`, `SELECTED GOAL`, `PLAN`, `CONTINUE ›`. Buttons are always micro-caps.
- **Placeholders are lower-case, trailing ellipsis, often italic:** "type your name…", "add a todo…", "what the plan is missing…", "e.g. a CLI tool that syncs my notes between devices".
- **Hints are lower-case fragments separated by middle dots:** "Tab cycles · ⌘⏎ new sibling · ⌘⌫ delete · double-click renames", "A sentence or two is fine · paste notes or attach links".
- **Explains the reason, not the feature.** Option rows carry a `why` line: "Without tools the agent can only talk, not act — this is what turns a chatbot into a coding agent."
- **Numbers as facts:** "3 goals · 9 todos", "Goal 1 of 3".
- **No emoji.** No exclamation marks. Em-dashes and middle dots are the punctuation of choice.
- **Chevrons as verbs:** `Continue ›`, `Send ›`, `Show pasted text ›`, `Hide text ⌃`.

## Visual foundations

- **Palette: one ink, five grays, one red.** `#171717` ink is text, filled buttons, selected borders, marks, the slider thumb — *the accent is the ink*. Grays: `#fafafa` rail/field fill, `#f2f2f2` hover wash, `#eaeaea` borders and rules, `#c9c9c9` strong borders / idle marks / slider track, `#8f8f8f` faint text, `#4d4d4d` secondary text. `#e70022` appears only on destructive hover (the × on a row). Dark scheme flips to `#0a0a0a` / `#ededed` with `#2e2e2e` borders and `#ff5e63` red. No brand hue, no gradients, no imagery.
- **Type: system-ui sans, weights 400 and 500 only** (600/700 in the older goals workspace). Sizes are fractional and precise — 9, 10, 11.5, 12.5, 13, 14.5, 19, 22, 24, 34px. Large text is tracked tight (−0.2 to −0.4px); tiny text is tracked wide (1.2–1.6px) and uppercased. Line-heights are generous for prose (1.7–1.8). Mono (Source Code Pro 12px) for drafts, notes, and commands.
- **Backgrounds:** flat white page. Rails and fields sit on `#fafafa`. No textures, photos, illustrations, or patterns. Depth comes from a 1px border, never a shadow.
- **Borders & cards:** 1px `#eaeaea` default; `#c9c9c9` on hover or for emphasized cards; ink `#171717` when selected/focused. Radius 8px for fields, options, cards; 6px in the dense workspace; 999px pills for buttons, seeds, name-row, commands; circles for marks and arrows. Cards have head / 1px rule / body, no shadow.
- **Shadows:** none. The only box-shadows are focus rings (`0 0 0 3px #f2f2f2` on the slider thumb, `0 0 0 2px #fafafa` on an editing input) and the Trajectory slide-in sheet (`-12px 0 32px rgba(0,0,0,.06)`).
- **Accent:** one blue, `#0070f3` (`--acc`), used only for inline links, the selected mark/stop, and focus rings. Primary buttons stay ink.
- **Buttons (default):** sentence case, 13px/500, 8px radius. Outline (`#eaeaea` border, ink text) by default; filled ink for the single primary action; `link` variant is accent text with no box. Legacy pill shape via `caps`.
- **Grouped rows:** a few related optional inputs sit as `ListRow`s inside a `#fafafa` `ListGroup` (1px separators, chevron when clickable) instead of a form.
- **Buttons (caps):** pills, tracked micro-caps. Outline default (transparent, `#eaeaea` border, `#4d4d4d` text) → hover `#c9c9c9` border, ink text. Filled (`.btn-on`): ink background, white text → hover opacity .86. Disabled: opacity .4 (wizard: `#f2f2f2` fill, `#8f8f8f` text). Padding 7px 15px (9px font) or 9px 18px (10px font).
- **Hover states:** color/border-color shift to the next darker gray, or `#f2f2f2` background wash on rows. Filled elements dim to .86 opacity. Text-only actions underline.
- **Press states:** the slider thumb scales 1.15; nothing else transforms.
- **Selection:** the border turns ink; a radio "mark" (11px circle, 1.5px border) fills ink. Selected rows do not change background.
- **Motion:** minimal. Hovers 120ms; pager dot stretches 140ms; each step enters with `rise` (opacity + 6px translateY, 260ms, `cubic-bezier(.25,.1,.25,1)`); the rail connector fills over 300ms; "generating" is a 3×3 grid of 3–4px dots pulsing at 1.1s with 90ms stagger. No bounces, no spring.
- **Layout:** fixed 340px rail + fluid center; content column max 600px (wizard) / 820px (setup column) / 1140px (workspace). A fixed "bypass" pill sits bottom-right. Sticky inspector at `top:16px`.
- **Transparency / blur:** not used, apart from the .35 scrim in Berkeley UI (out of brand).
- **Forms:** fields are `#fafafa` boxes with a transparent or `#eaeaea` border that turns `#c9c9c9` on focus-within; inputs are `all:unset` with no visible focus outline of their own. Textareas do not resize.
- **Progress:** numbered 18–27px circles connected by a 1–1.5px vertical line; done = ink fill with ✓, now = 2px ink ring, later = `#c9c9c9` ring. Pager dots 6px, active stretches to 20px.

## Iconography

- **No icon font, no SVG icons, no PNGs.** Every glyph is a Unicode character set in the UI font: `›` (go), `←` `→` (pager), `×` (remove), `+` (add), `✓` (done), `⌃` (collapse), `⤢` (expand), `≡` (pasted text), `↗` (link), `–` (todo bullet), `·` (separator), `⌘⏎ ⌫` (shortcut hints). Glyph sizes are 12–15px; `›` inside a button is 10–12px with zero tracking.
- Berkeley UI likewise uses none. The Trajectory view draws its graph with sigma.js (colored circles), not icons.
- **Emoji: never.**
- If a consuming design truly needs a pictorial icon, use Geist Icons or Lucide at 1.5px stroke and 14–16px, in `#8f8f8f` / `#4d4d4d` — and flag it as an addition.

## Intentional additions

- `ThinkingDots` is extracted as a component although the source inlines it — it recurs in three places.
- None of the components invent variants; every prop maps to a state in `setup.html` or the wizard DC.

## Index

- `styles.css` — entry; imports `tokens/{fonts,colors,typography,spacing,effects}.css`
- `guidelines/` — specimen cards (Principles, Colors, Type, Spacing, Motion, Brand)
- `components/actions/` — Button, ArrowButton, Seed
- `components/forms/` — Field, PillField, Option, Slider
- `components/navigation/` — StepRail, Pager, Tabs
- `components/content/` — MicroLabel, Card, ListGroup (ListRow, FileTile), Message, Inset, TodoRow, Attachment, Command, ThinkingDots
- `ui_kits/setup-wizard/` — the 9-step onboarding, click-through
- `ui_kits/goal-workspace/` — Vault-goals tree + inspector
- `research/setup-wizard-source.html` — extracted wizard DC source
- `SKILL.md`, `github.md`, `thumbnail.html`
