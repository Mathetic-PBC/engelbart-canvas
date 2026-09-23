// Ported from divadbaroon/engelbart-web @ afd4af9351850b454d438082f5c8d5ac3a34a8e0.
import { STATUS_LABEL, plainError } from "./build-events.js";
const STEP_ORDER = ["sandbox", "trail", "plan", "services", "environment", "start", "health", "live"];
const TITLES = {
  sandbox: "Sandbox",
  trail: "Railpack",
  plan: "Run Plan",
  services: "Services",
  environment: "Environment",
  start: "Install and start",
  health: "Health and repair",
  live: "Live"
};
const isOver = (run) => run?.status === "failed" || run?.status === "killed" || run?.status === "paused" || run?.status === "no_service";
const HEALTH_RUN_STATUS = /* @__PURE__ */ new Set(["needs_input", "setup_planning", "failed", "stopped", "error", "unhealthy"]);
const short = (sha) => typeof sha === "string" && sha ? sha.slice(0, 7) : "";
const day = (iso) => typeof iso === "string" ? formatDay(iso) : "";
function formatDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function planner(source) {
  if (source === "railpack") return "Command list from Railpack";
  if (source === "run_order") return "Command list from the run order";
  return typeof source === "string" && source ? `Command list from ${source}` : "";
}
function stepOf(e, seenReady) {
  const d = e.data ?? {};
  const phase = typeof d.phase === "string" ? d.phase : null;
  switch (phase) {
    case "trail":
      return d.status === "saved" || d.status === "shared" && d.saved === true ? "live" : "trail";
    case "recipe":
      return d.status === "captured" ? "live" : "trail";
    case "discover":
    case "order":
    case "plan":
      return "plan";
    case "supabase":
      return "services";
    case "environment":
      return "environment";
    case "approval":
      return "start";
    case "run":
      return HEALTH_RUN_STATUS.has(String(d.status)) ? "health" : "start";
    case "patch":
    case "visit":
      return "health";
    case "ready":
      return "live";
    // The pipeline concluded there is nothing to serve: at planning time
    // that is the plan's answer, later it is the health check's.
    case "conclusion":
      return d.step === "run" ? "health" : "plan";
    // The brief is read before the plan; the resolver is a second opinion
    // on a failure; a cost line stays with whatever step it was in.
    case "brief":
      return "plan";
    case "resolve":
      return "health";
    case "cost":
      return null;
    // Setting a repository up for use: the install, its check, and the result.
    case "setup":
      return "start";
    case "check":
      return "health";
    // The setup rung starting the application: the launch, then whether it answered.
    case "start":
      return d.status === "starting" || d.status === "leftover" ? "start" : "health";
    case "usable":
      return "live";
    // A pipeline error names the step it came from; before the app is up
    // that is where it belongs, not the health check.
    case "error": {
      const step = typeof d.step === "string" ? d.step : "";
      if (step === "discover" || step === "order" || step === "plan") return "plan";
      if (step === "setup" || step === "install") return "start";
      if (step === "environment") return "environment";
      if (step === "supabase") return "services";
      return seenReady ? "live" : "health";
    }
    case "exited":
      return seenReady ? "live" : "health";
  }
  if (typeof d.stage === "string" && (e.kind === "command" || e.kind === "stdout" || e.kind === "stderr")) return seenReady ? "live" : "start";
  const t = e.text;
  if (e.kind === "status") {
    if (t.startsWith("picked up by runner") || t === "creating" || t === "cloning" || t === "cloned" || t.startsWith("exit ") || "template" in d || t.startsWith("docker ") || t.startsWith("sandbox killed") || t.startsWith("could not list")) return "sandbox";
    if (t === "launching" || d.recipe === true || t.startsWith("could not hand over the saved recipe")) return "trail";
    if (t.startsWith("could not hand over the saved environment") || t.startsWith("using ") && t.includes("saved environment value")) return "environment";
    if (t.startsWith("service ") || t.startsWith("preview ")) return "live";
  }
  if (e.kind === "command") {
    if (t.startsWith("git clone") || t.startsWith("ls -A") || t === "dockerd") return "sandbox";
    if (t.startsWith("python3 ")) return "trail";
    if (t.includes("proxy.mjs")) return "live";
  }
  return null;
}
function runSteps(run, events, repoName) {
  const steps = {};
  for (const id of STEP_ORDER) steps[id] = { id, title: TITLES[id], state: "waiting", summary: "", error: null, startedAt: null, elapsed: 0, since: null, events: [], flag: null };
  let current = "sandbox";
  let seenReady = false;
  let openSince = null;
  const ms = (iso) => new Date(iso).getTime();
  for (const e of events) {
    const to = stepOf(e, seenReady);
    if (to && to !== current) {
      if (openSince) steps[current].elapsed += Math.max(0, ms(e.at) - ms(openSince));
      current = to;
      openSince = e.at;
    }
    openSince ??= e.at;
    if (e.data?.phase === "ready") seenReady = true;
    const s = steps[current];
    s.events.push(e);
    s.startedAt ??= e.at;
  }
  const over = isOver(run);
  const live = run?.status === "running" || run?.status === "usable";
  if (openSince) {
    if (over) steps[current].elapsed += Math.max(0, ms(events[events.length - 1].at) - ms(openSince));
    else steps[current].since = openSince;
  }
  summarize(steps, run, repoName);
  const reached = Math.max(0, ...STEP_ORDER.map((id, i) => steps[id].events.length ? i : -1));
  STEP_ORDER.forEach((id, i) => {
    const s = steps[id];
    if (i < reached) s.state = s.events.length ? s.flag ?? "done" : "skipped";
    else if (i === reached) s.state = run?.status === "failed" ? "failed" : over || live ? s.flag ?? "done" : run ? "active" : "waiting";
    else s.state = run?.status === "no_service" ? "skipped" : "waiting";
  });
  // Canvas can revisit install/plan during repairs. The latest event, rather
  // than the furthest numbered row, identifies the active or failed step.
  if (run && !live) {
    for (const id of STEP_ORDER) {
      if (id !== current && (steps[id].state === "active" || steps[id].state === "failed")) steps[id].state = steps[id].flag ?? "done";
    }
    steps[current].state = run.status === "failed" ? "failed" : run.status === "killed" ? "skipped" : !over ? "active" : steps[current].state;
    if (run.status === "failed" && run.error) steps[current].error = plainError(run.error);
    if (run.status === "killed") steps[current].summary = "Stopped";
  }
  if (run?.status === "no_service") {
    for (const id of STEP_ORDER) if (steps[id].state === "skipped") steps[id].summary ||= "Nothing to serve";
  }
  if (steps.services.state === "skipped") steps.services.summary ||= "Not needed";
  if (steps.environment.state === "skipped") steps.environment.summary ||= "Not scanned";
  if (run?.status !== "no_service") {
    if (steps.health.state === "skipped") {
      steps.health.state = "done";
      steps.health.summary ||= "Answered on the first check";
    }
    if (steps.plan.state === "skipped") {
      steps.plan.state = "done";
      steps.plan.summary ||= "Taken from the saved command list";
    }
  }
  if (steps.trail.state === "skipped") steps.trail.summary ||= "Not recorded";
  if (run?.status === "paused") steps.sandbox.summary = `${steps.sandbox.summary} \xB7 paused`;
  if (!run) steps.sandbox.summary ||= "Not prepared yet";
  // Advancing to a later stage does not turn an explicitly failed outcome into
  // success. A later recorded success for that same step can resolve it; stderr
  // and prose alone are not evidence of failure.
  for (const step of Object.values(steps)) {
    if (step.state !== "done") continue;
    const outcome = step.events.findLast((e) => e.kind === "error" || e.data?.phase === "error" || ["failed", "error", "ok", "done", "ready", "answering"].includes(e.data?.status));
    if (outcome && (outcome.kind === "error" || outcome.data?.phase === "error" || ["failed", "error"].includes(outcome.data?.status))) {
      step.state = "warned";
      step.error ||= String(outcome.data?.reason || outcome.data?.output || outcome.text);
    }
  }
  return STEP_ORDER.map((id) => {
    const { flag: _flag, ...step } = steps[id];
    return step;
  });
}
function summarize(steps, run, repoName) {
  const last = (id, pick) => [...steps[id].events].reverse().find(pick);
  const data = (e) => e?.data ?? {};
  {
    const creating = last("sandbox", (e) => "template" in (e.data ?? {}));
    const template = String(data(creating).template ?? run?.template ?? "");
    const docker = template.endsWith("-docker") ? " with Docker" : "";
    const made = !!creating || !!run?.sandboxId;
    const box = !made ? "" : isOver(run) ? `Sandbox stopped${docker}` : `Sandbox running${docker}`;
    const name = repoName || (run?.workdir ? run.workdir.split("/").filter(Boolean).pop() ?? "" : "");
    const cloned = last("sandbox", (e) => e.text === "cloned");
    const what = cloned ? `cloned${name ? ` ${name}` : ""}` : steps.sandbox.events.length ? `cloning${name ? ` ${name}` : ""}\u2026` : "";
    steps.sandbox.summary = [box, what].filter(Boolean).join(" \xB7 ");
  }
  {
    const trail = last("trail", (e) => e.data?.phase === "trail");
    const replay = last("trail", (e) => e.data?.phase === "recipe");
    const d = data(trail);
    const files = Array.isArray(d.files) ? d.files.length : typeof d.files === "number" ? d.files : 0;
    const from = [day(d.capturedAt), short(d.commit) && `at ${short(d.commit)}`, files ? count(files, "patched file") : ""].filter(Boolean).join(", ");
    let text = d.status === "own" ? `Replaying this project's command list${from ? ` from ${from}` : ""}` : d.status === "shared" ? `Replaying another project's command list${from ? ` from ${from}` : ""}` : d.status === "none" ? "No command list yet; analyzing from scratch" : d.status === "fresh" ? "Working the commands out from scratch, as asked" : last("trail", (e) => e.data?.recipe === true) ? "Replaying the saved command list" : steps.trail.events.length ? "" : "";
    const rd = data(replay);
    if (rd.status === "failed" || rd.status === "ignored") {
      text = `${text ? `${text} \xB7 ` : ""}the command list did not work${rd.reason ? ` (${String(rd.reason).slice(0, 80)})` : ""}; analyzing from scratch`;
      steps.trail.flag = "warned";
    }
    if (!text && steps.plan.events.length) text = "No command list; analyzed from scratch";
    steps.trail.summary = text;
  }
  {
    const plan = last("plan", (e) => e.data?.phase === "plan");
    const discovered = last("plan", (e) => e.data?.phase === "discover" && e.data?.status === "done");
    const comps = Array.isArray(data(discovered).components) ? data(discovered).components.length : 0;
    const summary = typeof data(plan).summary === "string" ? String(data(plan).summary) : plan ? plan.text.replace(/^plan: /, "") : "";
    const failed = last("plan", (e) => e.data?.phase === "error");
    const concluded = last("plan", (e) => e.data?.phase === "conclusion");
    const cd = data(concluded);
    const conclusion = concluded ? cd.status === "blocked" ? `Blocked: ${String(cd.reason ?? "").slice(0, 200)}` : `Nothing to serve: ${String(cd.reason ?? "").slice(0, 200)}` : "";
    const brief = last("plan", (e) => e.data?.phase === "brief");
    const bd = data(brief);
    const b = bd.brief ?? {};
    const briefLine = bd.status === "starting" ? "Reading the repository\u2026" : bd.status === "failed" ? "No brief" : "";
    const gaveUp = last("plan", (e) => e.data?.phase === "order" && e.data?.status === "gave_up");
    const gaveUpLine = gaveUp ? `The planner gave up: ${String(data(gaveUp).reason ?? "").slice(0, 160)}` : "";
    const ordered = data(plan).plan;
    const entry = ordered?.services?.find((s) => s.id === ordered.entryService) ?? ordered?.services?.[0];
    const start = String(data(plan).start ?? (Array.isArray(entry?.argv) ? entry.argv.join(" ") : "") ?? "").trim();
    const where = [entry?.cwd, b.primaryApp?.path].find((path) => typeof path === "string" && path && path !== ".") ?? "";
    const runs = start ? `Runs ${start}${where ? ` in ${where}` : ""}` : "";
    steps.plan.summary = [
      conclusion || gaveUpLine || runs || summary || briefLine || (failed ? "" : steps.plan.events.length ? "Analyzing\u2026" : ""),
      planner(data(plan).source),
      comps ? count(comps, "component") : ""
    ].filter(Boolean).join(" \xB7 ");
  }
  {
    const ev = last("services", (e) => e.data?.phase === "supabase");
    const d = data(ev);
    const reason = typeof d.reason === "string" ? d.reason : "";
    if (d.status === "ready") steps.services.summary = "Local Supabase ready";
    else if (d.status === "skipped") {
      steps.services.summary = reason ? `Local Supabase skipped: ${reason}` : "Not needed";
      steps.services.flag = "skipped";
    } else if (d.status === "unavailable" || d.status === "failed" || d.status === "timeout" || d.status === "needs_input" || d.status === "stopped") {
      steps.services.summary = `Local Supabase could not start${reason ? `: ${reason}` : ""}`;
      steps.services.flag = "warned";
    } else if (ev) steps.services.summary = reason ? `Local Supabase: ${reason}` : "Starting a local Supabase\u2026";
  }
  {
    const ev = last("environment", (e) => e.data?.phase === "environment" && Array.isArray(e.data?.variables));
    if (ev) {
      const vars = data(ev).variables;
      const found = vars.filter((v) => v.status === "found").length;
      const local = vars.filter((v) => v.status === "local").length;
      const saved = vars.filter((v) => v.status === "provided").length;
      const missing = Array.isArray(data(ev).skipped) ? data(ev).skipped.length : 0;
      const parts = [found ? `${found} in the repository` : "", local ? `${local} from the local Supabase` : "", saved ? `${saved} saved` : "", missing ? `${missing} missing` : ""].filter(Boolean);
      steps.environment.summary = parts.length ? parts.join(" \xB7 ") : "Nothing read from the environment";
      if (missing) steps.environment.flag = "warned";
    } else if (steps.environment.events.length) steps.environment.summary = "Scanning\u2026";
  }
  {
    const stages = steps.start.events.filter((e) => e.kind === "command" && typeof e.data?.stage === "string");
    const first = stages[0]?.data?.stage;
    const starts = stages.map((e, i) => e.data?.stage === first ? i : -1).filter((i) => i >= 0);
    const commands = starts.length ? stages.slice(starts[starts.length - 1]).map((e) => e.text.trim()) : [];
    const unique = commands.filter((c, i) => commands.indexOf(c) === i);
    const setup = last("start", (e) => e.data?.phase === "setup");
    const setupFailure = last("start", (e) => e.data?.phase === "setup" && e.data?.status === "failed" || e.kind === "error");
    const sd = data(setup);
    if (setup) {
      const summaries = { starting: "Installing and preparing…", working: "Preparing repository…", replaying: "Replaying saved setup…", reusing: "Restarting application…", fallback: "Switching setup provider…" };
      steps.start.summary = sd.status === "failed" ? (run?.status === "running" ? "Initial setup failed" : "Setup failed")
        : sd.status === "done" ? (setupFailure ? "Recovered after setup failure" : `Set up: ${String(sd.summary ?? "installed").slice(0, 160)}`)
        : summaries[sd.status] || "Setup activity recorded";
    } else steps.start.summary = unique.length ? `${unique.join(" \xB7 ")}${starts.length > 1 ? ` (${starts.length} passes)` : ""}` : steps.start.events.length ? "Starting\u2026" : "";
    if (setupFailure) {
      steps.start.flag = "warned";
      steps.start.error = String(data(setupFailure).reason || data(setupFailure).output || setupFailure.text);
    }
  }
  {
    const patch = last("health", (e) => e.data?.phase === "patch" && e.data?.status !== "starting");
    const starting = last("health", (e) => e.data?.phase === "patch" && e.data?.status === "starting");
    const need = last("health", (e) => e.data?.phase === "run" && e.data?.status === "needs_input");
    const unhealthy = last("health", (e) => e.data?.phase === "run" && e.data?.status === "unhealthy");
    const concluded = last("health", (e) => e.data?.phase === "conclusion");
    const check = last("health", (e) => e.data?.phase === "check");
    const visited = last("health", (e) => e.data?.phase === "visit");
    const err = last("health", (e) => e.kind === "error");
    const d = data(patch);
    const files = Array.isArray(d.files) ? d.files.length : 0;
    const attempt = d.attempt ?? data(starting).attempt;
    const resolved = last("health", (e) => e.data?.phase === "resolve" && (e.data?.status === "plan" || e.data?.status === "blocked" || e.data?.status === "failed"));
    const resolving = last("health", (e) => e.data?.phase === "resolve" && (e.data?.status === "starting" || e.data?.status === "reading"));
    const rd = data(resolved);
    const blocker = rd.blocker ?? data(concluded).blocker;
    const outcome = last("health", (e) => e.data?.phase === "start" || e.data?.phase === "check");
    if (outcome?.data?.phase === "start" && data(outcome).status === "failed") {
      steps.health.summary = `The application did not start: ${String(data(outcome).reason ?? "").slice(0, 160)}`;
      steps.health.flag = "warned";
    } else if (outcome?.data?.phase === "start" && data(outcome).status === "answering") steps.health.summary = "Application responding";
    else if (outcome?.data?.phase === "check") {
      const failed = ["failed", "error"].includes(data(check).status);
      steps.health.summary = data(check).status === "ok" ? "The check passed" : failed ? `The check failed: ${String(data(check).reason ?? data(check).output ?? "").slice(-160)}` : "Verifying live preview…";
      if (failed) steps.health.flag = "warned";
    } else if (concluded && data(concluded).status === "blocked") {
      steps.health.summary = `Blocked${blocker?.kind ? ` (${blocker.kind})` : ""}: ${String(blocker?.what ?? data(concluded).reason ?? "").slice(0, 200)}`;
      steps.health.flag = "warned";
    } else if (concluded) steps.health.summary = `Nothing to serve: ${String(data(concluded).reason ?? "").slice(0, 200)}`;
    else if (rd.status === "plan") {
      steps.health.summary = `The resolver corrected the plan: ${String(rd.hint ?? "").slice(0, 160)}`;
      steps.health.flag = "warned";
    } else if (rd.status === "blocked") {
      steps.health.summary = `Blocked${blocker?.kind ? ` (${blocker.kind})` : ""}: ${String(blocker?.what ?? "").slice(0, 200)}`;
      steps.health.flag = "warned";
    } else if (rd.status === "failed") {
      steps.health.summary = `The resolver could not decide${rd.reason ? `: ${String(rd.reason).slice(0, 120)}` : ""}`;
      steps.health.flag = "warned";
    } else if (resolving) steps.health.summary = data(resolving).status === "reading" ? "The resolver is reading files\u2026" : "The resolver is looking at why it stopped\u2026";
    else if (d.status === "applied") {
      steps.health.summary = `Repair attempt ${attempt ?? 1} edited ${count(files, "file")}`;
      steps.health.flag = "warned";
    } else if (d.status === "replayed") {
      steps.health.summary = `Saved edits applied again (${count(files, "file")})`;
      steps.health.flag = "warned";
    } else if (d.status === "none") steps.health.summary = "The repair agent found nothing to change";
    else if (d.status === "failed") { steps.health.summary = `Repair attempt ${attempt ?? 1} failed${d.reason ? `: ${String(d.reason).slice(0, 120)}` : ""}`; steps.health.flag = "warned"; }
    else if (d.status === "stale") steps.health.summary = "The saved edits no longer fit the repository";
    else if (starting) steps.health.summary = `Repair attempt ${attempt ?? 1}: the agent is looking for a fix\u2026`;
    else if (need) steps.health.summary = `Not answering: ${String(data(need).reason ?? "").slice(0, 160)}`;
    else if (unhealthy) steps.health.summary = `Opened the page: ${String(data(unhealthy).reason ?? "").slice(0, 160)}`;
    else if (err) steps.health.summary = err.text.slice(0, 160);
    else if (visited) steps.health.summary = `Opened the page in a browser${data(visited).title ? ` (${String(data(visited).title).slice(0, 60)})` : ""}`;
    else if (steps.health.events.length) steps.health.summary = "Checking\u2026";
  }
  {
    const ready = last("live", (e) => e.data?.phase === "ready");
    const services = Array.isArray(data(ready).services) ? data(ready).services.length : 0;
    const captured = last("live", (e) => e.data?.phase === "recipe" && e.data?.status === "captured");
    const shared = last("live", (e) => e.data?.phase === "trail" && e.data?.status === "shared");
    const exited = last("live", (e) => e.data?.phase === "exited" || e.data?.phase === "error");
    const usable = last("live", (e) => e.data?.phase === "usable");
    const ub = data(usable).blocker ?? run?.usage?.blocker;
    const parts = [
      isOver(run) ? "" : run?.status === "usable" || usable ? ub ? `Set up; blocked by ${ub.kind ?? "something"}: ${String(ub.what ?? "").slice(0, 120)}` : `Set up and ready to use${data(usable).summary ? `: ${String(data(usable).summary).slice(0, 120)}` : ""}` : run?.status === "running" && run.previewUrl ? "Preview ready" : ready ? "Ready" : "",
      services > 1 ? count(services, "service") : "",
      shared ? "command list saved and shared" : captured ? "command list saved" : ""
    ].filter(Boolean);
    if (exited) {
      parts.push(`stopped: ${String(data(exited).reason ?? exited.text).slice(0, 120)}`);
      steps.live.flag = "warned";
    }
    if (run?.status === "killed") {
      parts.push("stopped");
    }
    steps.live.summary = parts.join(" \xB7 ");
  }
}
const TONE = {
  queued: "working",
  creating: "working",
  cloning: "working",
  cloned: "working",
  launching: "working",
  running: "live",
  usable: "live",
  paused: "ended",
  no_service: "ended",
  killed: "ended",
  failed: "failed"
};
function runState(run, steps) {
  if (!run) return { headline: "Not prepared", detail: "", tone: "none" };
  const at = steps.reduce((found, s, i) => s.state !== "waiting" ? i : found, -1);
  const current = at >= 0 ? steps[at] : null;
  const tone = TONE[run.status];
  const error = plainError(run.error);
  if (tone === "failed" || tone === "ended") {
    const where = run.status === "failed" && current ? ` in ${current.title}` : "";
    return { headline: `${STATUS_LABEL[run.status]}${where}`, detail: error, tone };
  }
  if (tone === "live") {
    const blocker = run.usage?.blocker;
    const detail = blocker ? `Blocked by ${blocker.kind === "secret" ? "a missing key" : blocker.kind === "service" ? "a missing service" : blocker.kind}: ${blocker.what}` : run.status === "running" ? run.previewUrl ?? "" : run.usage?.summary ?? "";
    return { headline: STATUS_LABEL[run.status], detail, tone };
  }
  return { headline: STATUS_LABEL[run.status], detail: current ? `Step ${at + 1} of ${steps.length} \xB7 ${current.title}` : "", tone };
}
function stepDuration(step, now) {
  if (!step.startedAt) return null;
  return step.elapsed + (step.since && now !== null ? Math.max(0, now - new Date(step.since).getTime()) : 0);
}
function runDuration(steps, now) {
  const first = steps.find((s) => s.startedAt);
  if (!first) return null;
  return steps.reduce((sum, s) => sum + (stepDuration(s, now) ?? 0), 0);
}
function formatDuration(ms) {
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
export {
  STEP_ORDER,
  formatDay,
  formatDuration,
  planner,
  runDuration,
  runState,
  runSteps,
  stepDuration
};
