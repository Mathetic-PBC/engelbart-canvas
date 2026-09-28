# Post-it Quick Task — Hudson's tweaks

Claude Design project c321ac1f-2738-499d-b6e4-7e4df4e062aa, file `Post-it Quick Task.dc.html`, chat "Post-it note modal
design" (42 messages, 2026-09-27 19:52–20:35 UTC). Read through the signed-in claude.ai tab (`OmeletteService/GetFile`,
`GetProject`); the `claude_design` MCP returned 403. Hudson's messages, in order (verifier/"fixing" relays left out):

1. Recreate the post-it UI and the popup so it fits the post-it; it should not hide all the post-its — in front of them, a middle layer.
2. Put the send button on the same line.
3. Rather than a modal: move Build to the right of the note; hovering Build shows a model selector, add context, and send, like our other designs. Use the same black-and-white model selector, with library functionality, as Bart has.
4. "This is totally wrong": only on hover; the white panel should not be there — hover meant the model selector.
5. Remove all subtext; add context above; send at the bottom; not a hover action — only when I click Build; starting the build is on this popup.
6. Move add context to the library icon, next to the send button at the bottom.
7. It should say Context with the circumscribed plus: ⊕ "Context".
8. Searching the library should be a popout from this popout, not an expansion; like the sidebar's add context but without Note / Sub-Workspace.
9. It should neighbour the popout.
10. The library rows should not have circles.
11. Replace "Too big" with **Needs you**; remove the Build option while it runs; say **Building** with the three-dots animation.
12. Needs you prompts the person to add it to a workspace: a workspace selector, and a model selector defaulting to what they chose for that task.
13. Remove the (recent) option; there should be a search bar over all workspaces, sub-workspaces too.
14. Under Needs you: "This task was too complex to build outside of a workspace. You must add it to a workspace below to continue."
15. Adding a post-it to a workspace asks whether to delete the post-it or keep it.
16. Building dots are circles, not squares.

Final design (what was implemented, `src/renderer/post-its/{Card.jsx,face.css,PostItBuild.jsx,PostItTask.jsx,ModelGrid.jsx}`):
footer Copy | state word · Note · Build ⊙↑; Build popup 420px = model grid + foot (model effort, ⊕ Context · n, blue ↑);
Context popout 290px beside it, bottoms level; task card 420px (Building + activity + Stop | Needs you/Stopped +
workspace search + Discard + model chip + ↑ | "Added to X" + Keep task / Delete task).
