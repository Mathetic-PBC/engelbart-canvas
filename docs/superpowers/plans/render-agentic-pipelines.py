"""Render the two canonical planning documents as a standalone annotated reader.

Uses only the Python standard library. Run from any working directory:
python3 docs/superpowers/plans/render-agentic-pipelines.py
The output is a planning artifact; this script does not launch agents or the app.
"""

from pathlib import Path
import argparse
import hashlib
import html
import re


HERE = Path(__file__).resolve().parent
PLAN = HERE / "2026-09-18-agentic-pipelines.md"
SPEC = HERE.parent / "specs/2026-09-18-agentic-pipelines-design.md"

CSS = """
:root{--bg:#f5f0e6;--text:#3D3530;--text-muted:#6B6358;--text-tertiary:#9B9488;--accent:#5C3A1E;--card-bg:#FAF8F3;--card-border:#E8E2D8;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:17px;line-height:1.7;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
main{max-width:780px;margin:0 auto;padding:4rem 1.5rem 6rem}h1{font:normal 1.85rem/1.3 Georgia,serif;text-wrap:balance;margin:0 0 .6rem}h2{font:400 13px/1.5 var(--sans);text-transform:uppercase;letter-spacing:2.5px;color:var(--text-tertiary);margin:3rem 0 1rem}h3{font:normal 1.2rem/1.4 Georgia,serif;margin:2rem 0 .7rem}h4{font:600 1rem/1.5 var(--sans)}p,li{color:var(--text-muted)}p{margin:0 0 1.15rem}strong{color:var(--text)}a{color:var(--accent);text-underline-offset:3px}a:hover{color:var(--text)}.meta,.toc,.fine{font:12px/1.7 var(--sans);color:var(--text-tertiary)}.meta{margin-bottom:1.7rem}.toc{margin-bottom:2rem}.lead{font-size:1.15rem;color:var(--text)}.aside{border-left:2px solid var(--accent);padding:.2rem 0 .2rem 1rem;margin:1.5rem 0}.aside p{margin:0}.flow{display:flex;flex-wrap:wrap;gap:6px;padding:0;list-style:none;margin:1.5rem 0}.flow li{font:12px/1.5 var(--sans);padding:8px 10px;border:1px solid var(--card-border);background:var(--card-bg)}.flow li+li:before{content:'→ ';color:var(--accent)}.table-wrap{overflow-x:auto;border:1px solid var(--card-border);border-radius:4px;margin:1.2rem 0}table{width:100%;border-collapse:collapse;font-size:.9rem;background:var(--card-bg)}th{font:500 11px/1.6 var(--sans);text-transform:uppercase;letter-spacing:1px;color:var(--text-tertiary);text-align:left}td,th{padding:.6rem .75rem;vertical-align:top;border-bottom:1px solid var(--card-border)}td{color:var(--text-muted)}tr:last-child td{border:0}td:first-child{color:var(--text)}ul,ol{padding-left:1.4rem}li{margin:.5rem 0}code{font:12px/1.6 ui-monospace,Menlo,monospace;overflow-wrap:anywhere}p code,li code,td code{background:var(--card-bg);padding:1px 3px;border-radius:2px}pre{overflow-x:auto;padding:1rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:4px;font-size:12px;line-height:1.6}pre code{white-space:pre;overflow-wrap:normal}details{margin:1rem 0;border-top:1px solid var(--card-border);padding-top:.8rem}summary{cursor:pointer;font:500 14px/1.6 var(--sans);color:var(--accent)}details[open]>summary{margin-bottom:1.2rem}.detail-body{padding:.3rem 0 .8rem}blockquote{border-left:2px solid var(--card-border);padding-left:1rem;margin:1rem 0;color:var(--text-muted)}.check{list-style:none;margin-left:-1.3rem}.check::before{content:'☐';display:inline-block;width:1.3rem;color:var(--text-tertiary)}.provenance{margin-top:3rem;border-top:1px solid var(--card-border);padding-top:1rem;overflow-wrap:anywhere}[id]{scroll-margin-top:24px}
@media(max-width:700px){main{padding:2rem 1.1rem 4rem}h1{font-size:1.6rem}td,th{padding:.5rem}pre{font-size:11px}}
@media print{body{background:#fff}main{max-width:none;padding:0}details{break-inside:avoid}.toc{display:none}}
"""


def inline(text, base):
    tokens = []

    def keep(fragment):
        tokens.append(fragment)
        return f"\x00{len(tokens) - 1}\x00"

    text = re.sub(r"`([^`]+)`", lambda m: keep("<code>" + html.escape(m[1]) + "</code>"), text)

    def link(match):
        target = match[2]
        if not re.match(r"(?:https?://|#)", target):
            target = (base / target).resolve().as_uri()
        return keep(f'<a href="{html.escape(target, quote=True)}">{html.escape(match[1])}</a>')

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, text)
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: tokens[int(m[1])], text)


def render(markdown, base, prefix):
    """Render the Markdown subset used by these documents, escaping all raw HTML."""
    lines = markdown.splitlines()
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("```"):
            block = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                block.append(lines[i])
                i += 1
            out.append("<pre><code>" + html.escape("\n".join(block)) + "</code></pre>")
            i += 1
            continue
        heading = re.match(r"^(#{1,6}) (.+)", line)
        if heading:
            level = min(len(heading[1]) + 1, 6)
            anchor = prefix + "-" + re.sub(r"[^a-z0-9]+", "-", heading[2].lower()).strip("-")
            out.append(f'<h{level} id="{anchor}">{inline(heading[2], base)}</h{level}>')
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                row = [cell.strip() for cell in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", cell) for cell in row):
                    rows.append(row)
                i += 1
            rendered = []
            for n, row in enumerate(rows):
                tag = "th" if n == 0 else "td"
                rendered.append("<tr>" + "".join(f"<{tag}>{inline(cell, base)}</{tag}>" for cell in row) + "</tr>")
            out.append('<div class="table-wrap"><table>' + "".join(rendered) + "</table></div>")
            continue
        marker = re.match(r"^(?:- |\d+\. )", line)
        if marker:
            tag = "ul" if line.startswith("- ") else "ol"
            items = []
            pattern = r"^- " if tag == "ul" else r"^\d+\. "
            while i < len(lines) and re.match(pattern, lines[i]):
                item = re.sub(pattern, "", lines[i])
                checkbox = item.startswith("[ ] ")
                if checkbox:
                    item = item[4:]
                cls = ' class="check"' if checkbox else ""
                items.append(f"<li{cls}>{inline(item, base)}</li>")
                i += 1
            out.append(f"<{tag}>" + "".join(items) + f"</{tag}>")
            continue
        if line.startswith("> "):
            out.append("<blockquote>" + inline(line[2:], base) + "</blockquote>")
            i += 1
            continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(?:#|```|\||- |> |\d+\. )", lines[i]):
            paragraph.append(lines[i])
            i += 1
        out.append("<p>" + inline(" ".join(paragraph), base) + "</p>")
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    reader_dir = Path.home() / "Desktop/Codex Readings"
    parser.add_argument("--output", type=Path, default=reader_dir / "09-18-2026-engelbart-agentic-pipelines-plan.html")
    parser.add_argument("--annotator", type=Path, default=reader_dir / "_annotator.html")
    args = parser.parse_args()
    spec, plan = SPEC.read_text(), PLAN.read_text()
    annotator = args.annotator.read_text()
    annotator = "\n".join(line for line in annotator.splitlines()
                          if "prefers-color-scheme:dark" not in line and ':root[data-theme="dark"]' not in line)

    implementation, verification = plan.split("\n## Verification and release discipline", 1)
    verification = "## Verification and release discipline" + verification
    intro, *chunks = re.split(r"(?=^## PR \d+ — )", implementation, flags=re.M)
    phases = []
    for chunk in chunks:
        title, body = chunk.split("\n", 1)
        n = int(re.search(r"PR (\d+)", title)[1])
        phases.append(f'<details id="pr-{n}"><summary>{html.escape(title[3:])}</summary>'
                      f'<div class="detail-body">{render(body, PLAN.parent, f"pr{n}")}</div></details>')
    digest = hashlib.sha256((spec + plan).encode()).hexdigest()[:16]
    document = f"""<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Engelbart — implementing agentic pipelines</title><style>{CSS}</style></head><body><main>
<p class="meta">IMPLEMENTATION PROPOSAL · 18 SEPTEMBER 2026 · engelbart-canvas @ 31d700c</p>
<h1>Make delegation a complete loop.</h1>
<p class="lead">Select a question, dispatch it with the right context, keep thinking, and integrate what comes back. Build that once before increasing the number of agents.</p>
<p>This plan translates your delegation precedents and handoff protocol into the current Electron app. Research is the first usable slice; isolated code changes follow immediately. The first three PRs complete the loop. Later PRs add concurrency, the secretary, Codex parity, editable plans, and discovery.</p>
<p class="toc"><a href="#sequence">Build order</a> · <a href="#boundary">Design boundary</a> · <a href="#details">Implementation tasks</a> · <a href="#design">Specification &amp; evidence</a></p>
<ol class="flow" aria-label="Delegation flow"><li>Capture intent</li><li>Pin context</li><li>Run</li><li>Inspect return</li><li>Integrate or reframe</li></ol>
<div class="aside"><p><strong>The product test:</strong> when a result arrives, can you tell what it changes about the parent question without reconstructing the entire investigation?</p></div>

<h2 id="sequence">The build order</h2>
<p>The existing app already supplies workspaces, context references, and native terminals. It still simulates chat replies and task completion. The missing layer connects intent, execution evidence, and the return to the workspace.</p>
<div class="table-wrap"><table><thead><tr><th>PR</th><th>Deliverable</th><th>Exit condition</th></tr></thead><tbody>
<tr><td><a href="#pr-1">1 · Records &amp; context</a></td><td>Immutable task revisions, source snapshots, event history</td><td>The request reopens with exactly the context dispatched.</td></tr>
<tr><td><a href="#pr-2">2 · One real worker</a></td><td>Claude transport, lifecycle, cancellation and recovery</td><td>A real result persists; interrupted work has an explicit outcome.</td></tr>
<tr><td><a href="#pr-3">3 · Workspace loop</a></td><td>Select → dispatch → return → review → integrate</td><td>You continue writing and integrate without losing newer edits.</td></tr>
<tr><td><a href="#pr-4">4 · Concurrent code</a></td><td>One worktree per task, combined validation, one integration lane</td><td>Overlapping changes cannot overwrite the active checkout.</td></tr>
<tr><td><a href="#pr-5">5 · Handoffs</a></td><td>Worker → secretary → policy → queue → action → return</td><td>A dropped connection cannot cause an uncertain action to repeat.</td></tr>
<tr><td><a href="#pr-6">6 · Codex parity</a></td><td>App Server adapter, shared contract tests, usage measurements</td><td>The same round trip works through the second backend.</td></tr>
<tr><td><a href="#pr-7">7 · Adaptive plans</a></td><td>Editable dependencies and human/agent ownership</td><td>Reframing preserves old work and flags stale downstream tasks.</td></tr>
<tr><td><a href="#pr-8">8 · Discovery &amp; evaluation</a></td><td>Scoped suggestions, explicit automation policies, attention-cost pilot</td><td>More delegation reduces coordination work without increasing errors.</td></tr>
</tbody></table></div>

<h2 id="boundary">Keep these distinctions in the architecture</h2>
<p><strong>A workspace organizes thought; a dependency graph schedules work.</strong> Nesting one question under another does not mean every task must execute in that order. A task can remain attached to its source passage without creating another folder.</p>
<p><strong>A returned answer, accepted evidence, and an integrated change are different events.</strong> Store the result separately. Attach the original question, assumptions, source locators, unresolved issues, and implications. Let the user select what enters the live document. Keep prior versions when a question changes.</p>
<p><strong>The harness owns execution authority.</strong> The secretary evaluates a bounded request; the runtime checks authorization and dispatches it. One action per project is insufficient for shared resources: the same desktop, browser session, or repository needs a lock across projects.</p>
<p><strong>A small fix should stay small.</strong> “Copy the formatting, including ##” needs an acceptance example and a tested diff. It does not need a procession of planner and reviewer agents before work begins. Large ambiguous requests first return a spec and the decisions it depends on.</p>
<p>For prompt caching, stabilize and version the common context prefix, then measure reported reuse. Local retrieval reuse, session continuation, and model-side caching are separate mechanisms. Native providers construct some of the prompt themselves; identical project names do not establish identical cache prefixes.</p>

<h2>What to validate before autonomous task discovery</h2>
<p>Start with two workers after the single-worker loop is usable. Make ordinary returns visible without stealing focus. Keep task discovery in a proposal queue until its review cost is understood. The plan includes a 20-episode comparison with the current terminal workflow: active briefing, supervision, review, integration, and rework time, alongside material errors.</p>
<p>The proposed product hurdle is a 25% reduction in median active coordination time with no increase in material errors. This is a chosen hurdle, not an effect established by the cited studies. Less interaction time does not by itself demonstrate better thinking or scientific novelty.</p>

<h2 id="details">Implementation tasks</h2>
<p>Each expandable PR includes file ownership, interfaces, implementation steps, failure cases, and verification. The design section below records the source rationale and exact constraints.</p>
<details id="contracts"><summary>Runtime contracts, file map, and global constraints</summary><div class="detail-body">{render(intro, PLAN.parent, 'contracts')}</div></details>
{''.join(phases)}
<details id="verification"><summary>Release gates, verification, and requirement coverage</summary><div class="detail-body">{render(verification, PLAN.parent, 'verification')}</div></details>
<details id="design"><summary>Complete proposed design, source rationale, and acceptance criteria</summary><div class="detail-body">{render(spec, SPEC.parent, 'spec')}</div></details>

<div class="provenance"><p class="fine">Planning only. The existing test suite passed 69/69; provider execution and the proposed pipelines have not been implemented or tested. Sources: the supplied 97-entry guide, current Engelbart planning notes, the originating September 18 conversation, August dogfooding notes, current repository code, installed CLI help, and linked primary sources.</p>
<p class="fine">Canonical files: <a href="{PLAN.as_uri()}">implementation plan</a> · <a href="{SPEC.as_uri()}">design specification</a>. Regenerate with <code>python3 docs/superpowers/plans/render-agentic-pipelines.py</code>. Source digest: {digest}.</p>
<p class="fine">Select text + Enter to highlight. Select text + type to add a margin comment. Annotations stay in this browser's local storage.</p></div>
</main>
<script>document.addEventListener('click',function(e){{var a=e.target.closest('a[href^="#"]');if(!a)return;var t=document.getElementById(a.getAttribute('href').slice(1));if(!t)return;var d=t.closest('details');if(d)d.open=true;}});document.addEventListener('toggle',function(){{window.dispatchEvent(new Event('resize'));}},true);</script>
{annotator}
</body></html>"""
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(document)
    print(args.output)
    print(f"Source digest: {digest}; {len(document):,} characters")


if __name__ == "__main__":
    main()
