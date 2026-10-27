'use strict';
// A task built from its own line (MATH-106, 2026-10-25): its `- [ ]` line holds the Build's id as an HTML comment right
// after the box, `- [ ] <!--build:<id>--> Add the export`, and `<!--build:<id> ticked-->` once the accepted Build has
// ticked it (so a task unticked by hand afterwards is not ticked again). The comment goes first so the task's text is the
// line's end, as the editor reads every drawn line (model/doc.js lineText); outside the app it is markdown no renderer
// shows. One grammar for the renderer (model/doc.js parseLine) and main (everything that reads a workspace's text):
// the marker is never shown, searched, cited or handed to an agent.

const TASK_MARK_RE = /<!--build:([0-9a-f]{10})( ticked)?--> ?/;
const TASK_MARKS_RE = new RegExp(TASK_MARK_RE.source, 'g');

/** `text` with every task marker taken out. */
function stripTaskMarkers(text) {
  const value = String(text ?? '');
  return value.includes('<!--build:') ? value.replace(TASK_MARKS_RE, '') : value;
}

/** A task's text read: { text } without its marker, and the Build it names ({ build, ticked }) when it has one. */
function readTaskMark(text) {
  const value = String(text ?? '');
  const m = value.includes('<!--build:') ? TASK_MARK_RE.exec(value) : null;
  return m ? { text: stripTaskMarkers(value), build: m[1], ticked: !!m[2] } : { text: value };
}

/** The marker for a task's Build `id`, written before its text (with the space after it); '' with none. */
const taskMark = (id, ticked = false) => (id ? `<!--build:${id}${ticked ? ' ticked' : ''}--> ` : '');

module.exports = { TASK_MARK_RE, stripTaskMarkers, readTaskMark, taskMark };
