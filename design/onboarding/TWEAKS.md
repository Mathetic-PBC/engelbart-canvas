# Onboarding — design source and Hudson's tweaks

Design: Claude Design project c321ac1f-2738-499d-b6e4-7e4df4e062aa, file `Onboarding.dc.html` (chat "Engelbart onboarding flow",
86 messages, read 2026-09-28). Implemented in `src/renderer/screens/Onboarding.jsx`, `src/renderer/model/onboarding.js`,
`src/main/store/onboarding.cjs`. The welcome picture is Hudson's attachment (`design/assets/welcome-field.png`).

Final flow in the design: new user = Welcome → Add to your library → Custom instructions → Create a new project → Project
context (5 steps, pager + "n of m"); existing user (+ Project) = Create → Context. The "Library" and "Projects" intro screens
of the original note were deleted in the chat (msg 68: "add subheading and delete previous page"). All of it sits in an
800×600 card ("it will actually be much smaller … because it is on app open", msg 46).

Tweaks, in order (message numbers from the chat):
- 2: "Create a folder for me" goes in the home directory (`~/<slug>`), not under ~/.engelbart.
- 6: custom instructions = two options, "Import from an AI provider" or "Write my own".
- 7/22/76/80/84: Skip for now is plain grey text on the left; Continue is always there, greyed out until something is added
  (instructions: until text is pasted); Next sits inside the box, on the right, greyed until the part has something.
- 24/26: the import sources are a list with an open circle that becomes a green check; proper icon per source.
- 27/39/72: Websites (plural), Papers; Folders and the not-yet-built sources (Overleaf, Zotero, Drive) removed.
- 32/33: GitHub is the native GitHub sign-in, then a searchable repository list with ticks.
- 36/44: continuing opens the next part automatically; skipping never loses what was added.
- 38/42: websites = a scrollable list of what was added and a thin paste bar under it; duplicates refused ("already added");
  no dashes, no delete ×, no "in your library" section.
- 46: papers list what was added too.
- 48/70: the component inside scrolls, never the page.
- 52–58/68: the prompt is not shown, only a Copy prompt button; the prompt text is the long research-profile prompt
  (`PROFILE_PROMPT` in model/onboarding.js).
- 60/72: the import screen is parts 2a GitHub → 2b Websites → 2c Papers, one box at a time (the create screen likewise:
  name → description → folder).
- 80: "Choose repositories in browser…" is text to the left of Next, not a separate row.

Hudson, after trying it with `npm run new-mac` (2026-09-28, the Onboarding build):
- The window is all white: no grey page and no white card. The content is centred on it, in the same 800×600 at most, so
  lists still scroll inside and the page never does.
- No grey containers: GitHub's sign-in and repositories, the websites and papers lists, the create fields, the prompt
  row and the empty-library note sit directly on the white. Inputs keep their borders.
- One button: Continue walks the parts of a screen (2a → 2b → 2c, name → description → folder) as Next did, greyed
  until the part holds something; Skip for now stays on the left. "Choose repositories in browser…" moved under the list.
- A tools screen, second (6 screens now): what the setup dialog asked on a first launch (Git missing, no agent), with
  Skip for now on the left and Install all on the right. Install all moves on at once and the installs run in the
  background; the setup dialog is held back until onboarding is over and then asks only what is left (signing in).
  Skip for now asks nothing more until the next launch. The screen is left out when nothing is to be installed.
