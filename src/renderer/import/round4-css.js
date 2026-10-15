// Round 4 of onboarding (2026-10-14, Hudson's "Ad hoc changes"): after ROUND3_CSS so it wins.
//   - What is chosen is outlined, thinner, everywhere in the flow: black again (From Amitav, 2026-10-15; it was a lighter
//     grey for a day, "I was wrong about it being black").
//   - Import your context is a screen of its own (it was a dialog over the picker).
//   - Specify context per category, "Saved websites from {app}" rows, Choose from Obsidian, the email field's spacing.
//   - From Amitav (2026-10-15): every logo on the intro, fitted to the window down to its smallest (900×560); Add a
//     project the size of a project; no project icons.
export const ROUND4_CSS = `
.ix.ix{--chosen:#171717}
.ix.ix .role-card[aria-checked=true],.ix.ix .project-choice[aria-checked=true],.ix.ix .tool-choice[aria-checked=true],.ix.ix .scope-option[aria-checked=true],.ix.ix .prof[aria-checked=true],.ix.ix .question-option[aria-checked=true]{border-color:var(--chosen);box-shadow:inset 0 0 0 .5px var(--chosen)}
.ix.ix .review-source.selected>.review-source-row{border-color:var(--chosen);box-shadow:inset 0 0 0 .5px var(--chosen)}
.ix.ix .review-project[aria-checked=true]{border-color:var(--chosen);background:#fafafa;box-shadow:none}
.ix.ix :is(input,textarea,select):focus{border-color:var(--chosen)}
.ix.ix .import-mode.prof:hover,.ix.ix .provider-choices .prof:hover{border-color:var(--chosen)}

.ix .intro-page{position:relative}
.ix .intro-page .welcome{width:min(780px,100%);padding:0 0 24px}
.ix .intro-page .welcome,.ix .intro-page .lead{text-align:center}
.ix .intro-page .lead{margin:0 auto 30px}
/* ten logos a row, the buttons below as wide as the row */
.ix .intro-page .icons{gap:10px;margin:0 auto 36px;max-width:calc(10 * 52px + 9 * 10px)}
.ix .intro-page .actions{justify-content:space-between;align-items:center;width:100%;max-width:calc(10 * 52px + 9 * 10px);margin:0 auto}
@media(max-height:720px){.ix .page.intro-page{padding-top:48px;padding-bottom:48px}.ix .intro-page .lead{margin-bottom:22px}.ix .intro-page .icons{gap:8px;margin-bottom:26px;max-width:calc(10 * 44px + 9 * 8px)}.ix .intro-page .actions{max-width:calc(10 * 44px + 9 * 8px)}.ix .intro-page .ic{width:44px;height:44px}.ix .intro-page .ic img{width:24px;height:24px}}
.ix .intro-page .scratch-link{font-size:13px;text-decoration:underline;text-underline-offset:3px;color:var(--mute);white-space:nowrap}
.ix .intro-page .scratch-link:hover{color:var(--ink)}
.ix .intro-page .intro-close{position:absolute;top:18px;right:18px}
@media(max-width:540px){.ix .intro-page .actions{gap:16px}.ix .intro-page .actions .btn{width:auto;min-width:0;max-width:215px;white-space:normal;font-size:13px;line-height:1.35;padding:8px 14px}.ix .intro-page .scratch-link{font-size:12px;white-space:normal;text-align:left}}

.ix .links-logo{position:relative;flex:none;width:17px;height:17px;display:inline-grid;place-items:center}
.ix .links-logo>img,.ix .links-logo>svg{width:17px;height:17px}
.ix .links-globe{position:absolute;right:-5px;bottom:-4px;width:11px;height:11px;border-radius:50%;background:#fff;box-shadow:0 0 0 1.5px #fff;display:grid;place-items:center;color:#4d4d4d}
.ix .links-globe svg{width:11px;height:11px;stroke-width:1.9}
.ix .review-logo .links-logo{width:26px;height:26px}
.ix .review-logo .links-logo>img{width:26px;height:26px}

.ix .group-context{margin:2px 0 10px}
.ix .group-context-row{display:flex;padding:0 12px}
.ix .group-context .review-context{padding:4px 12px 8px}
.ix .review-projects-note{margin:0 0 8px}
.ix .review-context-label{margin:16px 0 8px}
.ix .review-context .sender-input{margin-top:10px;gap:14px}
.ix .review-context .sender-input .field{margin:0;padding:9px 12px;font-size:13.5px}
.ix .review-context .sender-input .link{font-size:12.5px;white-space:nowrap}
.ix .review-context .sender-chips{margin-top:10px}
.ix .review-context .folder-upload{margin-top:12px}
.ix .review-context .selected-folder-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ix .review-context .selected-folder-list>div{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:7px}
.ix .review-context .selected-folder-list svg{width:13px;height:13px;color:var(--mute)}

.ix .first-projects .prof{justify-content:flex-start;gap:12px;min-height:48px;padding:10px 14px;font-size:14.5px}
.ix .first-projects .prof>span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}
.ix .first-projects .prof>svg:last-child{width:15px;height:15px;color:#0070f3}
/* a project's height with one line under its name: the name, that line, padding and border */
/* no icon before a project (From Amitav): its name and line take the room, when it was worked on stays by its circle */
.ix.ix .project-choice>span:first-child{flex:1;min-width:0}
.ix.ix .project-choice>.project-recency{flex:none}
.ix.ix [data-import-screen=projects] .add-project{min-height:calc(14px * 1.45 + 12px * 1.55 + 2px + 24px + 2px);padding:12px 14px;font-size:14px}

.ix .modal.obsidian-modal{width:min(540px,100%);padding:22px 22px 18px}
.ix .ob-search{display:flex;align-items:center;gap:8px;margin:14px 0 8px;padding:0 10px;border:1px solid var(--line);border-radius:8px}
.ix .ob-search svg{width:14px;height:14px;color:var(--mute)}
.ix.ix .ob-search .field{flex:1;min-width:0;border:0;margin:0;padding:8px 0;font-size:13px;box-shadow:none}
.ix .ob-tree{min-height:120px;max-height:min(380px,50vh);overflow:auto;margin:0 -6px;padding:2px 6px}
.ix .ob-row{position:relative;display:flex;align-items:center;gap:4px;height:28px;padding-right:6px;border-radius:5px;cursor:pointer;font-size:13.5px;color:#262626;user-select:none}
.ix .ob-row:hover{background:#f2f2f2}
.ix .ob-row.is-on{background:#ececec}
.ix .ob-guide{position:absolute;top:0;bottom:0;width:1px;background:#ececec}
.ix .ob-chev{width:14px;height:14px;flex:none;display:grid;place-items:center;color:#a3a3a3}
.ix .ob-chev svg{width:11px;height:11px;stroke-width:2;transition:transform .12s}
.ix .ob-chev.open svg{transform:rotate(90deg)}
.ix .ob-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ix .ob-vault>.ob-row:first-child .ob-name{font-weight:600}
.ix .ob-name small{margin-left:8px;font-size:11.5px;color:var(--mute)}
.ix .ob-box{width:16px;height:16px;flex:none;border:1.5px solid var(--line2);border-radius:4px;background:#fff;padding:0;display:grid;place-items:center;opacity:0}
.ix .ob-row:hover .ob-box,.ix .ob-box.on{opacity:1}
.ix .ob-box.on{background:#0070f3;border-color:#0070f3;color:#fff}
.ix .ob-box svg{width:11px;height:11px;stroke-width:2.2}
.ix .ob-empty{padding:24px 8px;font-size:13px;color:var(--mute)}
.ix .ob .mf{margin-top:14px}
.ix .ob-count{margin-right:auto;font-size:12px}
`;
