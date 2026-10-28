# EngelbartScreens — API

All projects (`screens/Home.jsx`), onboarding / + Project / the guided setup (`screens/Onboarding.jsx`,
`model/onboarding.js`), the guided setup's one-time offer (`ui/GuidedSetup.jsx`), and the document preview Home draws
(`ui/DocPreview.jsx`). Behaviours and status: `mac/parity/screens.md`. Depends on Core, UI, Store, Doc, Integrations
(GitHub picker), Tools (the tool snapshot). SwiftUI views, each also wrapped as an `NSHostingController`.

## Entry points the app calls

### All projects (`ScreenSlots.home`)
```swift
let home = HomeModel(context: HomeContext(
    data: StoreScreensData(store: store),                    // or any HomeData
    onCreateScreen: { model.newProject() },                  // + Project
    onOpenWorkspace: { projectId, workspaceId, stageRow in … },   // card (workspace nil), tile, peek holder; stageRow: show it on the Stage
    onOpenNote: { row in … },                                // a note row: open in its project (tab = note id / name)
    onOpenOnStage: { row in … },                             // a row no project holds: Stage of the last-open (else first) project
    onRename: { id, name in … },
    onDelete: { id in await … },                             // nil hides the cards' cans
    onRestore: { id in await … },
    onLibraryChanged: { await model.loadHome() },
    addToLibrary: nil))                                      // the Sidebar's AddToLibrary (see Needs); nil = a stand-in
home.update(projects: [PublicProject], trashed: [TrashedProject],
            library: HomeLogic.shownLibrary(rows, trashed: trashed),   // App.jsx shownLibrary: trashed projects' rows hidden
            error: String)                                   // call again whenever any of them changes
// or, from RootModel's JSON lists: home.update(projectsJSON: …, trashedJSON: …, libraryJSON: model.shownLibrary, error: model.error)
AnyView(HomeScreen(model: home))                             // or HomeViewController(context:chrome:) (its .model)
```
Keep one `HomeModel` per window while it shows home (the peek, the search and the trash dialog live in it). `PublicProject`
must carry `workspaceCount`, `lastEdited`, `recent` and `libraryIds` (Store.listProjects does).

### Onboarding (`ScreenSlots.onboarding`)
```swift
let onboarding = OnboardingModel(context: OnboardingContext(
    mode: .new | .existing | .guided,       // GuidedSetup.onboardMode(guidedFromProject:guided:returning:) = App.jsx's
    into: guidedProjectId,                  // the guided setup's project (mode .guided)
    data: StoreScreensData(store: store),   // or any OnboardingData
    agents: OnboardingAgents(providers: { fresh in … }, rememberProvider: { … }, toolsInstall: { … }, toolsUpdate: { … }),
    onTools: { model.onboardingTools(install: $0 == "install") },
    onDone: { made, extras in await model.onboarded(projectId: made.projectId, workspaceId: made.workspaceId,
                                                    note: made.landingTab, …, stageLinks: extras.stageLinks) },
    onBack: returning ? { Task { await model.leaveOnboarding() } } : nil,
    backTitle: GuidedSetup.backTitle(guidedFromProject: …),
    pickDirectory: { await Dialogs.pickDirectory(…) },
    copyText: { Dialogs.writeClipboard($0) },
    github: githubPaneModel,                // Integrations' GithubPaneModel (nil: "GitHub is not set up in this build.")
    importSignins: { open in ImportSigninsWindow.show(over: window, importer: …, onOpenSite: open) },  // nil off a Mac
    importFlow: { request in AnyView(…) },  // ImportUI (see Needs); nil: a new user walks the screens that need no agent
    connectLibrary: { request in AnyView(…) },
    agentSetup: { request in AnyView(…) },
    hub: .shared, platform: "darwin"), tools: currentToolsSnapshot)
onboarding.setTools(snapshot)               // every engelbart:tools snapshot (ToolsSnapshot(json:) reads the JSON shape)
AnyView(OnboardingScreen(model: onboarding))   // or OnboardingViewController(context:tools:chrome:)
```
Make a NEW model when `RootModel.run` changes (a test reset or "Start as a new user…" starts over from the first screen,
App.jsx `key={run}`). The screen reads the library itself and listens to `engelbart:library-changed` on `hub`.
`Onboarded.landingTab` is App.jsx onboarded's tab rule (the Welcome! note unless the walkthrough, the Welcome page or no
note); `OnboardedExtras.stageLinks` are the sites to open on the Stage, `session` Import your context's.

### The guided setup
- `GuidedSetupOffer(onStart:onDismiss:)` — the one-time offer over the workspace (`ScreenSlots.guidedOffer`:
  `GuidedSetupOffer(onStart: { model.acceptOffer() }, onDismiss: { model.dismissOffer() })`). Escape and the veil dismiss.
- `GuidedSetup.startEvent` (`"engelbart:guided-setup"`) and `GuidedSetup.start(hub)` — Settings ▸ Import context posts it;
  the app's RootModel answers with `startGuided()`.
- `GuidedSetup.onboardMode(guidedFromProject:guided:returning:)`, `GuidedSetup.backTitle(guidedFromProject:)`.

## Contexts and data
- `HomeData` (addLibraryItem, addLibraryFile, addLibraryUrl, pickLibraryPaths, previewLibraryItem, projectsForLibraryItem,
  libraryBodies) and `OnboardingData` (library, addLibraryItem → (row, sandboxError), lookupLibraryItem, discardLibraryItem,
  pickLibraryPaths, instructions, setInstructions, freeFolder, checkFolder, startProject, welcomeWorkspace, projectAbout,
  connectOfferSeen): the api.* calls, named as preload.cjs names them. `StoreScreensData(store:)` implements both on the Store.
- `HomeAddHandlers` (what Home gives AddToLibrary: onAdd, onPickDisk, onPickRepo(url,row), onSearchPick(.item/.fresh),
  library, inRail), `SearchPick`.
- Slot requests: `ImportFlowRequest` (platform, onDone(Onboarded, OnboardedExtras), renderLibrarian(LibrarianRequest)),
  `LibrarianRequest`, `ConnectLibraryRequest` (sessionId, project: ProjectAbout?, pager, onSession, onContinue, onSkip,
  onBack, onAdded(row)), `AgentSetupRequest` (tools, providers, onDone(choice 'claude'|'codex'|'both'), onSkip).
- `AgentProviders` (providers.cjs's status; `init?(json:)`), `ToolsSnapshot(json:)` (extension).

## Pure models (also used by the tests)
- `OnboardingFlow`: FLOWS, isFresh, flowOf, SUBS, forward, pagerOf, shownPager, toolsWanted, agentWorks, agentReady,
  toolsStep, TOOL_WHY, importButtons, createButtons, endOf, projectInput (→ `ProjectInput.start`), rowWhy, contextRows,
  PROFILE_PROMPT, CLIS, providerOfCli, cliOfProvider, CONNECT_TO, connectLabel, choiceIds, subscribedCli, cliStage,
  gitMissing, agentGate, agentChoice, keychainStep, profilesOf, afterAllow, runKeychain — model/onboarding.js whole
  (ImportUI's AgentSetup/ImportFlow can use agentChoice/keychainStep from here).
- `HomeLogic`: rows, kindLabel, matches, shownLibrary, relative, day, cardMeta, heldIcons, tiles, peekFrame,
  workspaceTrail, source; delays OPEN/SWITCH/CLOSE.
- `DocPreview(text:maxLines:tail:size:)` (view) and `DocPreviewModel.lines/attributed`; `ItemPeek(row:more:onOpenWorkspace:)`
  (the library row's hover card: the workspace sidebar shows the same card); `FlowLayout` (flex-wrap, stretch);
  `welcomeWidth(window:)`.
- `ProbeBook` + `EnvironmentValues.probeBook`: every part named after its Electron `data-*` attribute carries it as its
  `.driveID` (DriveRegistry marker + accessibility identifier); with a ProbeBook in the environment it also records its
  frame and press (offscreen tests).

## Drive identifiers (`.driveID`, EngelbartUI; ENGELBART_DRIVE finds them)
Home: `screen=home`, `library-rail`, `library-add`, `library-add-error`, `home-search`, `library-row=<id>`, `rail-add`,
`rail-add-field`, `home-error`, `project-card=<id>`, `project-name=<id>`, `rename-project`, `held-icons`,
`delete-project=<id>`, `delete-project-dialog`, `delete-project-cancel`, `delete-project-confirm`, `workspace-tile=<id>`,
`new-project`, `recently-deleted`, `trashed-project=<id>`, `restore-project=<id>`, `peek=item|workspace`, `peek-local`,
`peek-missing`, `holder=<project>`, `holder=<project>/<workspace>`.
Onboarding: `onboarding=<mode>`, `step=<step>` (`step=import-context`), `welcome`, `welcome-picture`, `onboarding-back`,
`onboarding-continue`, `onboarding-skip`, `onboarding-step-of`, `onboarding-error`, `onboarding-mark=done|open`,
`part=<github|url|pdf|name|desc>`, `onboarding-items`, `onboarding-link`, `onboarding-link-add`, `onboarding-entry-error`,
`onboarding-pick-papers`, `onboarding-import-signins`, `github-signout`, `github-install`, `option=import|own|<row id>`,
`onboarding-copy-prompt`, `onboarding-instructions`, `onboarding-name`, `onboarding-desc`, `onboarding-use-folder`,
`onboarding-new-folder`, `onboarding-folder-path`, `onboarding-selected`, `onboarding-context`, `onboarding-add-to-library`,
`onboarding-open`, `onboarding-opening`, `connect-library-page`. Offer: `guided-offer`, `guided-offer-start`,
`guided-offer-dismiss`, `guided-offer-veil`.

## Events
Listens to `engelbart:library-changed` (onboarding's library). Posts `engelbart:guided-setup` (GuidedSetup.start).

## Needs from other packages
- **Sidebar**: Rail.jsx `AddToLibrary` as `(HomeAddHandlers) -> AnyView` for `HomeContext.addToLibrary` (the "Add context"
  row and its menu: search, a link or a path, Choose from disk…, Add from GitHub). Until then Home draws a stand-in row
  (circled plus, "Add context") opening a link-or-path field and "Choose from disk…".
- **ImportUI**: `import/ImportFlow.jsx` mode 'new' for `importFlow` (it makes the projects and calls `onDone` with the one to
  open, as `Onboarded`); `screens/ConnectLibrary.jsx` mode 'onboarding' for `connectLibrary`; `import/AgentSetup.jsx` for
  `agentSetup`. Without them a new user walks Create → Add to your library → Custom instructions (Connect counted as
  dropped), and the guided setup does the same without Create.
- **Connect / ImportUI**: `importApi.providers(fresh)` and `rememberProvider` for `OnboardingAgents`.
- **Tools**: `ToolsChannels.install(["git"])` / `update(id)` for `OnboardingAgents.toolsInstall/toolsUpdate`, and every snapshot
  to `OnboardingModel.setTools`.
- **Stage**: `ImportSigninsWindow.show(over:importer:onOpenSite:)` for `importSignins`.
- **App**: RootModel keeps the phases and App.jsx's logic (onboarded, leaveOnboarding, startGuided, the offer's timing,
  test reset → `run`); it holds Store-typed lists for Home (`PublicProject`, `TrashedProject`, `LibraryRow`) or maps its
  own `ProjectSummary` back to them.
