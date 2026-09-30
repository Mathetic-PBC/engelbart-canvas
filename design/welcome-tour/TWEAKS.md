# Welcome tour — design source and Hudson's tweaks

Design: Claude Design project c321ac1f-2738-499d-b6e4-7e4df4e062aa, file `Welcome Tour v2.dc.html` (chat "Welcome
animation design", 32 messages, read 2026-09-29). Implemented in `src/renderer/screens/WelcomeTour.jsx`; App.jsx shows it
after a new install's onboarding ("Open project") and on Engelbart ▸ Welcome Tour.

Hudson's asks, in order (message numbers from the chat):
- 1: a welcome over the Getting started screen; stickies hidden.
- 11: the steps: what a workspace is; switch workspaces (hover) and + New (hover); Add context → paste https://mathetic.com;
  open it in the Stage; a note; @bart about the website; what Build is (in the workspace); Build to begin coding.
- 17–19: no "Do it for me" (it just does it); the todo block with Copy all / Build all is gone ("that feature is gone").
- 21/23: Build and @bart look exactly like the app's; a big hand (not an arrow, not a disclaimer in the card) sits on
  what to hover or click; nothing flashes; the build finishes.
- 27: step 2's text is his; old steps 11 and 12 are one ("What Build does"); action steps need the real hover/click (Next
  stays off); no blue outline on the hand.
- 29/30: clicking the URL field fills in mathetic.com and adds it; clicking the @bart line types the question and sends
  it (nothing to type); a last step opens the finished build in a live preview.

What the port changes, and why (everything else is the design's markup, text, steps and timings):
- Header rows drag the window; the crumb starts after the traffic lights, so "Engelbart / <project> / Getting started"
  is ellipsized by the browser (the design had "Engelb…" and "Getting start…" typed in). The project is the person's.
- No "TEST · OFF" pill: the app's own controls sit top right (only a developer's copy has test mode).
- The root fills the window (the design had a 680px minimum and let the page scroll; the window can be 560 tall).
- Closing (Done, or Escape) opens the real project instead of showing "Replay tour ›"; the menu item replays it.
- Only in windows smaller than the design ever ran in: the Add context menu opens upward when it would leave the window,
  the card moves off the thing to click when it would cover it, and a click anywhere on the @bart line asks.
- The onboarding's first workspace is now "Getting started" (was "Welcome"), the name the tour shows.

Checked 2026-09-29 by walking both the design's preview and the app (1440×900) through the same 26 checkpoints with real
mouse input: same step, Next state and card text at each; screenshots pixel-identical outside the crumb row and the top
right, save frames caught mid-animation. At 900×560 the app finishes the same 26-checkpoint sequence.
