// Ported from divadbaroon/engelbart-web @ afd4af9351850b454d438082f5c8d5ac3a34a8e0.
const STATUS_LABEL = {
  queued: "Waiting for a runner\u2026",
  creating: "Creating sandbox\u2026",
  cloning: "Cloning\u2026",
  cloned: "Cloned. Starting the application\u2026",
  paused: "Cloned, sandbox paused",
  launching: "Starting the application\u2026",
  running: "Running",
  usable: "Set up and ready to use",
  no_service: "Nothing to serve",
  failed: "Failed",
  killed: "Stopped"
};
const VENDOR = /:\s*\[[^\]]{0,40}\]|(?:^|\s)This error is likely due to/;
function plainError(error) {
  const said = error?.trim();
  if (!said) return "";
  const at = said.search(VENDOR);
  const head = at > 0 ? said.slice(0, at).replace(/[\s:;,-]+$/, "") : said;
  return /[.!?]$/.test(head) ? head : `${head}.`;
}
function mergeEvents(existing, incoming) {
  const bySeq = new Map(existing.map((e) => [e.seq, e]));
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
function terminalLines(events) {
  const lines = [];
  let open = null;
  let replace = false;
  let stage;
  let phase;
  for (const e of events) {
    const stream = e.kind === "stdout" || e.kind === "stderr";
    // Never join separate status/error records, streams, or command stages.
    if (!stream || open?.kind !== e.kind || stage !== e.data?.stage || phase !== e.data?.phase) { open = null; replace = false; }
    stage = e.data?.stage;
    phase = e.data?.phase;
    if (e.kind === "metrics") continue;
    // Plain log output, not a terminal emulator: remove color/erase-line escapes.
    const text = String(e.text || "").replace(/\x1b\[[0-9;]*[mK]/g, "");
    for (const part of text.split(/(\r\n|\r|\n)/)) {
      if (part === "\r") {
        // Defer replacement until more text arrives. A trailing CR must not erase
        // the latest progress frame, including when CR/LF crosses chunk boundaries.
        replace = true;
      } else if (part === "\n" || part === "\r\n") {
        if (!open) lines.push({ kind: e.kind, text: "" });
        open = null; replace = false;
      } else if (part) {
        if (!open) { open = { kind: e.kind, text: part }; lines.push(open); }
        else open.text = replace ? part : open.text + part;
        replace = false;
      }
    }
    if (!stream) { open = null; replace = false; }
  }
  return lines;
}
export {
  STATUS_LABEL,
  mergeEvents,
  plainError,
  terminalLines
};
