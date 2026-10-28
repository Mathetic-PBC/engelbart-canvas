# EngelbartUI — public surface

The primitives every screen uses: tokens, fonts, icons, buttons, rows, panels, tabs, fields, animations, Settings. Ported
from `src/renderer/tokens/*.css`, `styles.css`, `wave.css` and `src/renderer/ui/*`; behaviours and their status are in
`mac/parity/ui.md`. Depends on Core only. macOS 14, SwiftUI + AppKit.

## Standing rules (Hudson's, memory note `no-horizontal-dividers.md`)
- No horizontal divider lines in lists, dialogs or menus: use spacing. (Settings' card keeps its inset hairlines, as the
  code at 9413a56 has them.) Selected = black (ink) 1.5px outline. No explanatory hint subtext unless Hudson asked for it.
- Colours and fonts only from these tokens. No drop shadows except where the CSS has one (each listed below).
- 1 CSS px = 1 pt. Every value here is the CSS's.

## Tokens (`Tokens.swift`, `Typography.swift`)
- `Palette`: the light palette (`gray0…gray900`, `red600`, `blue600/700/100/400`) and the semantic names (`bg panel panel2
  tint hov ink mut fnt bd bd2 line lineSoft acc accHov accBg accHovBg onAcc del dtxt ring flash`), plus the named one-offs
  components use (`wash2 navOn gearHover settingsPanel settingsBorder settingsLine settingsHairline fieldBorder tabHover
  tabCloseHover rowHover rowActive rowActiveHover iconIdle iconHover focusInset veil veilLight waveFloor waveRed*`).
  `NSColor(hex:)`, `Color(_ ns: NSColor)`.
- `Radius` (xs 6, sm 8, md 10, lg 12, pill 999), `Border` (1, mark 1.5, now 2), `Space` (s1…s9), `Pad` (the CSS paddings as
  EdgeInsets), `Widths` (rail 340, wizard 600, column 820, inspector 300).
- `Motion`: `fast 0.12 med 0.14 rise 0.26 slow 0.3`, `hoverOpacity .86`, `disabledOpacity .4`, `easeRise`, `ease(seconds)`.
- `Fonts.register()` (once at launch; the app does it), `Fonts.sans/mono/caveat/geist(size, weight:)` → NSFont,
  `Fonts.swiftUISans/swiftUIMono` → Font, `Fonts.nsWeight/swiftUIWeight(css)`.
- `TextStyle` (a CSS `font:` shorthand: size, weight, line height, tracking, family, uppercase) with the scale as statics
  (`.microcap .microcapLarge .button .row .meta .t11 … .t14 .prose .cardTitle .question .goalTitle .wizardTitle .hero .brand
  .mono .monoNotes .body`); `view.textStyle(_:)` applies one.
- `Images.named("trash")` (design/assets), `ResourceBundle.ui` (this package's resources, found in a signed .app's
  Contents/Resources as well as a build folder — **use `ResourceBundle.named("<Package>_<Module>", fallback: Bundle.module)`
  in your package rather than `Bundle.module` directly**: SwiftPM's accessor looks at the .app root, which a signed app
  cannot hold, and crashes when it finds nothing).

## Icons (`Icons.swift`, `SVGPath.swift`)
Drawn from the renderer's own SVG path data, in the colour around them.
- `IconView(icon, size:)` (SwiftUI, takes `.foregroundStyle`), `icon.image(size:)` (template NSImage), `icon.swiftUIPath`.
- `KindIcons` (Icons.jsx: `gh pdf layers folder code workspace note file doc html search chat globe image task expand
  collapse`), `KindIcons.kind(key, label:)` (the KIND map: glyph + label, unknown → file), `KindIcons.glyphSize(key)`,
  `KindGlyph(key, box:, color:)` — pass `kindKey(row)` (the Stage's model/kind.js).
- `SidebarIcons` (SidebarIcons.jsx: `inbox inboxDot agents connections library add project workspace search chevronDown
  chevronRight link note file folder star starFilled code gear panelClose panelOpen plus paperclip check close minusCircle
  trash archive chat pencil external sticky(hidden:) dots compose clock image globe paper git arrowOut`, `agentsPath` for the
  editor, `source(kind)`), `FolderPlusIcon`.
- `SettingsIcons` (`model blocks add flask gear search selectChevron`), `PhosphorIcons.shapesBold` (the editor's 20px shapes
  button; MIT notice in Resources/Icons/phosphor-LICENSE.txt), `GlyphBox(16|14) { … }` (`.glyph16/.glyph14`).
- `SVGPath.parse(d)` → CGPath, for icons of your own (e.g. the editor's HAMMER_PATHS): `Icon(name, grid:, stroke:, size:, shapes)`.

## Controls
- `EButton(title, .outline|.filled|.link|.blue|.ghost, size: .lg|.sm, caps:, go:, title: tooltip) { }` or with a label
  builder; `EngelbartButtonStyle` for any Button. (ui/Button.jsx + App.jsx's blue and ghost buttons.)
- `OptionRow(label, on:, many:, why:, boxed:, size:) { }` (Option.jsx), `Pager(count:, index:)`, `ThinkingDots(label:, size:)`.
- `WaveText(text, tone: .grey|.red, font:)` (`.eb-wave`; every wave on one clock: `WaveClock`).
- `InlineField(placeholder:, initial:, width:, autoFocus:, onCommit:, onCancel:)` — focuses with all selected the moment it
  is in a window; Enter commits trimmed (empty cancels), Escape cancels, leaving commits (`InlineFieldOutcome`). The editor
  builds its own fields on `InlineTextField` / `FocusingTextField`.
- `FluidTab(on:, sep:, lifted:) { TabTitle(text, weight:, color:); TabClose { } }`, `TabCardTimer` (650 / 60 / 400 ms) +
  `TabCardView(title:, detail:)`, `FluidTabMetrics` (max 220, min 44, height 34).
- Hover classes as modifiers: `.hover(.ink|.wash|.inkWash|.wash2|.inkWash2|.del|.dim|.tab|.closeX|.outline|.save, radius:)`,
  `.hoverBorder(radius:, rest:, focused:)` (`.hov-bd2`/`.focus-bd2`), `.ring(radius:, active:)`, `.focusRing(_:)`.
- Animations: `.rise(seconds)`, `.blink()`, `.pulse(period:, delay:)`, `.waiting()` (github-wait), `.spinning()`,
  `.addedFlash(trigger)`, `.askFlash(trigger)`; `Keyframe` (shared clock, CSS cubic-bezier).
- `.tip(text, key:, shortcut:)` — the app's tooltip after 350 ms (`.sb-tip`); `TooltipFace`, `TooltipTiming.spot`.
- `ErrorPage(title:, message:, details:, onReload:)` — a screen that could not load.
- `KeyMonitor(keyCode:) { used }` — a key taken before the window's responders (capture-phase keydown).
- Title bar: `.titleBar()` on a header row (drags the window; double click per System Settings), `.titleLead()` on its
  first column (84 left padding unless full screen; reads the `WindowChrome` environment object the app provides),
  `TitleBarMetrics.header` (54).

## Floating panels (`FloatingPanel.swift`, `Place.swift`)
- `view.floatingPanel(isPresented:, options: FloatingOptions(side: .below|.right, gap:, align: .start|.end, cap:, width:,
  card:, rise:, takesKey:, passive:, dismissible:, ignore:)) { content }` — hung from `view`.
- Or AppKit: `let p = FloatingPanel(); p.show(in: window, anchor: rectInContentYDown, options:) { … }`, `p.update { … }`,
  `p.move(anchor:)`, `p.close()`, `p.onClose`; `FloatingPanel.anchorRect(of: nsView)`, `FloatingPanel.stack` (layers).
- A child NSPanel: above WKWebView/PDFKit/terminal views, moves with the window, never drags it; becomes key so a field in it
  focuses at once; Escape closes the newest; a press outside closes it unless inside a newer panel or on `ignore`.
- Placement: `Placement.place(anchor, size:, view:, gap:, margin:, align:, side:)` / `Placement.beside(...)` (place.js).
- The standard card: `.modifier(PanelCard(radius:))` (white, 1px #e6e6e6, radius 10, the sidebar's two-layer shadow).

## Settings (`SettingsView.swift`, `SettingsRows.swift`, `ModelsPage.swift`)
- `SettingsDialog(pages:, context: SettingsContext(test:, close:), initialPage:)` — the app shows it; screens open it by
  setting the window's `RootModel.settingsPage` (the sidebar's gear and Connections panel: `"connections"`).
- `SettingsPages.standard(models:, connections:, startImport:)` (Models, Connections, Import context (an action), Test data);
  `SettingsPage(id:, section:, title:, icon:, keywords:, shown:, body:, run:)` to add one; `SettingsPages.matches/sections/initial`,
  `SettingsEscape.action`, `DiscoverLevels.all`, `TestDataActions`, `TestDataPage`, `SettingsGearButton`.
- Rows for any settings page (Connections uses them): `SettingsGroup(title, note:) { rows }`, `SettingsRow(label, icon:,
  hint:, detail:) { control }`, `SettingsButtonStyle(color:)`, `SettingsChoice(label, value:, options:, width:, onChange:)`.
  A page with a "…" menu sets `@Environment(\.settingsMenuOpen)` while it is open so Escape closes the menu first.
- Models: `ModelsPage(source: ModelSettingsSource)`; `Intelligence` (shownProviders, defaultProvider, defaultStep,
  patchOf, modelsGroups, effortLabels).

## Pure models
- `Panes.openBeside/closePane/sameDoc`, `Pane`, `DocRef` (model/panes.js).
- `WelcomePlace.landing(tree, given:, current:)` with `WelcomeTree` (model/welcome-place.js).

## Driver identifiers (for `ENGELBART_DRIVE`, mac/Engelbart/API.md)
Name a view with `.driveID("sb-row=x")`: it sets the accessibility identifier and leaves a marker NSView in
`DriveRegistry`, which is how the driver finds, scrolls to and clicks it (SwiftUI builds no accessibility tree on a CI
runner, which has no accessibility client). Name views after the Electron `data-*` attribute they stand for
(`data-sb-row="x"` → `sb-row=x`). This package's: `settings-gear`, `settings-dialog`, `settings-search`,
`settings-page=<id>`, `settings-close`, `settings-no-results`, `settings-item=reveal|start-new|reset`,
`intelligence-levels`, `levels-provider=<provider>`, `level=<provider>:<level>`, `models-file-error`.

## Corners
CSS `border-radius` is circular: use `RoundedRectangle(cornerRadius:, style: .circular)` and `Capsule(style: .circular)`
where the shape is large enough to show it (pills). On the macOS 26 SDK a default capsule drew flattened ends (seen in a
cloud snapshot of the Test pill).

## Needs from other packages
- Bart: a `ModelSettingsSource` over its model settings, whose JSON also carries `models.providerOrder` and each provider's
  `modelOrder` (file order; JSONValue objects are unordered, and the Models page lists Haiku before Sonnet as the file does).
- Stage: `kindKey(row)` / `kindLabel(row)` (model/kind.js) to feed `KindGlyph` / `KindIcons.kind`.
