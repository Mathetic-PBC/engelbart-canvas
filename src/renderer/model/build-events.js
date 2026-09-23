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
  for (const e of events) {
    if (e.kind === "stdout" || e.kind === "stderr") {
      const parts = e.text.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < parts.length; i++) {
        const frame = parts[i].split("\r").pop() ?? "";
        const last = i === parts.length - 1;
        if (open && open.kind === e.kind) open.text = parts[i].includes("\r") ? frame : open.text + frame;
        else if (!(last && frame === "")) {
          open = { kind: e.kind, text: frame };
          lines.push(open);
        }
        if (!last) open = null;
      }
      continue;
    }
    open = null;
    if (e.kind === "metrics") continue;
    lines.push({ kind: e.kind, text: e.text });
  }
  return lines;
}
export {
  STATUS_LABEL,
  mergeEvents,
  plainError,
  terminalLines
};
