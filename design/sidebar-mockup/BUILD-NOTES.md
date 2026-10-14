# The sidebar, built (2026-10-13)

The app's sidebar now follows `Sidebar.html` in this folder: the final state of the Codex session, committed as the
reference. The pure rules are in `src/renderer/model/sidebar.js`. `test/sidebar-plan.test.cjs` runs the mockup's own
script beside the app's model for every project of the tree. For each one it checks that going there leaves the same
shortlist, the same rows in the same order, the same row behind each More, and the same guide line.

## Where the app differs from the mockup, and why

| Mockup | App | Why |
|---|---|---|
| Tabs in the middle hold project pages and notes from anywhere | The app's tabs stay per project: the project's document first, then notes; the project page is a tab of its own | The tab model is the app's (views, scroll positions per project) and was not part of the sidebar spec |
| A clock row opens in a new tab | A project row goes to that project; a note opens as a tab (or comes to the front); the project page opens as its tab | Follows from the line above |
| Add picker has no disk chooser | "Choose from disk…" sits under "Upload URL or path" once it is open | So picking files from disk is not lost |
| A disk folder in the library becomes a shared folder | A disk folder is an item with the folder icon; Sources' folders are only the ones you make (global, in `state.json` `folders`) | The spec: "global folders … can contain the subset of the library items" |
| Archived versions are not shown | They are at the bottom of Projects' More | So Clear's versions stay reachable |
| An empty project folder shows nothing | It shows "+ Note" | From the spec's first list ("add a + Note button under the notes") |
| The add picker always hides once the pointer leaves | It stays while it is adding, while GitHub's sign-in or list is open, and while a link is typed in its field | Signing in to GitHub leaves the window, so the picker would have closed mid-flow |

## Calls made without you

- **Project page:** `<project>/.project.md`. Notes cannot start with a dot, so no note can take that name. It is made with
  the project from its onboarding description; projects made before this get one the first time the page is opened.
  Every @bart, Brainstorm, Discover and Build reads it as `<project_page>`, unless it still says only the description
  (which the head already carries). Renaming its title renames the project.
- **Agent states:**
  - A Build in review counts as needing you until it is accepted or discarded.
  - Failed, conflict, interrupted and escalated count as failed. Stopped, accepted and discarded are not counted.
  - An inline ask that finished counts as "finished" until its project is opened (as the Inbox did).
- **⌘J:** goes to what failed first, then what needs you, then what finished, oldest first within each. It skips the one
  it just went to. With nothing waiting, it goes to the project written in before (the old ⌘J).
- **Ctrl+1–9:** this top-level project's level-2 projects in tree order, from anywhere, the terminal included. ⌘1–9 is
  now only the tabs (it was ⌘ or Ctrl).
- **Switcher counts:** for the other top-level projects these come from `state.json` agents only, because their Builds
  are not loaded.
- **Shortlist:** an empty place is filled by the project worked in last. The mockup never refilled one.
- **Files outside your home folder:** a picture or pdf is kept as a copy (your "Get rid of this issue!"); anything else
  there is still refused.
- **Vocabulary:** user-facing "workspace" is now "project" across the app (cards, trash, post-it tasks, Stage, peek,
  "Untitled Project n"). Code, IPC and on-disk names are unchanged, so nothing on disk is migrated.

## A consequence of the mockup's rules

The ten-row budget can hide the level-4 project you are in. In that case its parent shows in bold, the parent's
chevron opens the More panel, and resting on the parent shows it.

## Not verified

- The native traffic lights could not be seen: the Mac was locked, so screenshots were refused. The title row is laid
  out on the lights' middle (27px, from `trafficLightPosition` y 20) and measured over CDP.
- The mouse was driven over CDP, not with OS-level events (also blocked by the lock).
