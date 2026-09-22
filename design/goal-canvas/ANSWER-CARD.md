# Answer Card: Hudson's tweaks and the numbers (Claude Design, 2026-09-21)

Source: `Answer Card.dc.html` in the Goal Canvas project (`c321ac1f-2738-499d-b6e4-7e4df4e062aa`), chat "Toggle prompt
output visibility", 36 messages. Implemented in `src/renderer/workspace/DocEditor.jsx` (spec decisions 58-60).
The file's markup was read through the signed-in Chrome tab (`OmeletteService/GetFile` → `console.log`, addresses
removed, since the extension's output filter refuses text holding query strings); the chat through `GetProject`.

## What Hudson said, in order

1. Allow me to toggle Show/Hide on the prompt output even after I have deleted everything. Change the buttons from pills to like text or something, I hate the AI look of the copy delete and save pills.
2. Change Hide to delete. Then still have a hide/show toggle.
3. Make copy the copy icon and then it should say copy when I hover. Delete should be a trashcan. Show and hide should be Collapse and Expand icons. Always have action written on hover. Copy should copy your message and the response. Delete should delete everything.
4. Now add the ability to ask a follow up question.
5. (drawing) everything should have grey background, even the question; [only the answer keeps the rule; no divider above the follow-up].
6. (screenshot) this is what follow up should kinda look like. [`@bart` + caret left; one pill right: model ⌄ and a round ↑]
7. Once I type the button should turn blue (the send button). Also next to copy there should be a rerun icon where when I hover the model selector is there and then I can hit send in the actual model selector in the lower right.
8. The rerun should be called just "Regenerate" when I hover and then if I click it the modal should sort of pop out to choose the model. On the send button the outline should be a lighter grey when I hover, not black. Also model selector looks wrong, it should look like this [Bart Selector]. Actually regenerate should just regenerate using same model and effort as the original message, but when I hover I should see the selector and it should be the same as this except with a send button in lower right.
9. Don't add the send button on the model selector for the message, only on rerun. Also, allow me to edit the model response.
10. The regenerate model selector should go under the regenerate button, meaning it'll have to slightly overlap with bart which is fine.
11. Get rid of the save button since this is default behavior.
12. Get rid of the "Regenerate" popup that is under the model selector for regenerate.
13. Add a hint that says "Respond" → it should not be italicized → nevermind it should be, decrease font slightly → add ... after Respond.

From the Engelbart doc that asked for the build: the trash deletes the single turn (question and answer), not the turn
before it; nothing says "Resumed from previous chat".
Mid-build, in the terminal: no dotted vertical line beside the answer while it is being written (smaller and lighter is
enough); the steps toggle is a plain angle with square ends.

## Numbers taken from the file

- Card `#fafafa`, radius 10, 14 below. Question `12px 16px 4px`, 16px/1.6, `@bart` `#0070f3` 500. Follow-up question `10px 16px 4px`.
- Answer `8px 16px 0`, `#4d4d4d`, 16px/1.65; rule `border-left:2px solid #dcdcdc; padding:2px 0 2px 12px`; paragraphs 22 apart, bullets 8 apart with a `#8f8f8f` `•` and a 10 gap; bold is `#171717` 600; the focused block tints `#f2f2f2` with a 4px spread, radius 4.
- Foot `display:flex; gap:4px; padding:8px 12px 10px`. Icon buttons 28×28, radius 6, `#4d4d4d`; hover `#f2f2f2` + `#171717`, Delete `#e70022`; Copy goes `#8f8f8f` while it reads Copied. Regenerate carries `margin-right:auto`. Attribution 12px/1.6 `#8f8f8f`, 8 to its right. Tooltip: white, `1px #eaeaea`, radius 6, `4px 7px`, 12px/1.2, 4 below, 120ms.
- Icons: Lucide copy, rotate-cw, chevrons-down-up (Collapse), chevrons-up-down (Expand), trash-2; 16px, 1.5 stroke, round.
- Follow-up row `gap:10px; margin:0 12px 12px; padding:16px 4px 6px`. Field 16px/1.5, placeholder `Respond…` italic 14.5px `#8f8f8f`. Pill `5px 6px 5px 12px`, `1px #eaeaea` (hover and open `#c9c9c9`), radius 999, 13px; chevron 12px stroke 2 `#8f8f8f`; divider 1×14 `#eaeaea`; send 24 round, `#f2f2f2`/`#8f8f8f` → `#0070f3`/`#fff` with text, hover opacity .86, arrow 13px stroke 2.2.
- Selector: the Bart Selector (`BartPicker.jsx`), 6 under what opened it; from Regenerate it hangs from the icon's left edge and carries a 28 round `#0070f3` button with the rotate icon (14px, 2.2), `padding:6px 4px 0`, right-aligned.

## Where the build departs from the mock

- A foot on **every** turn (the mock: one foot, bare text under follow-ups), because Delete removes one turn.
- Collapse folds one answer (the mock: the whole card). The fold is `bart+> ` in the file, the mock's "per-answer flag".
- Not built: `collapsedPreview` (off by default in the mock); the pill's send becoming a regenerate icon while Regenerate is hovered (predates tweak 9).
- The in-progress row keeps the app's own (activity, steps, Stop), now without a rule and with text buttons.
