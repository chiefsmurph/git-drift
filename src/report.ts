import { ageLabel, isNew, newChecks } from "./history.js";
import type { CheckResult, CleanupItem, Finding, Status } from "./types.js";

export type Format = "text" | "markdown" | "html" | "json";

const ICON: Record<Status, string> = { ok: "✓", drift: "✗", error: "!" };

export function counts(results: CheckResult[]) {
  return {
    ok: results.filter((r) => r.status === "ok").length,
    drift: results.filter((r) => r.status === "drift").length,
    error: results.filter((r) => r.status === "error").length,
  };
}

/** Whether this run knows when problems were first seen (a state file was used). */
const tracked = (results: CheckResult[]) => results.some((r) => r.findings.some((f) => f.firstSeen));

export function headline(results: CheckResult[], when = new Date()): string {
  const c = counts(results);
  if (!c.drift && !c.error) return `all ${c.ok} checks clean`;
  const n = newChecks(results, when);
  const fresh = tracked(results) ? (n ? ` (${n} new)` : " (nothing new)") : "";
  return [c.drift && `${c.drift} drifted`, c.error && `${c.error} failed to run`, `${c.ok} clean`].filter(Boolean).join(", ") + fresh;
}

/** Problems first (new ones ahead of ones already reported), then clean checks; `quiet` drops the clean ones. */
function ordered(results: CheckResult[], quiet: boolean, when: Date): CheckResult[] {
  const rank: Record<Status, number> = { error: 0, drift: 1, ok: 2 };
  const fresh = (r: CheckResult) => (r.status !== "ok" && r.findings.some((f) => isNew(f, when)) ? 0 : 1);
  return results
    .filter((r) => !quiet || r.status !== "ok" || r.findings.length)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.status] - rank[b.r.status] || fresh(a.r) - fresh(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** " (new)" or " (since Oct 5 · day 3)" after a problem, when a state file is in use. */
function age(f: Finding, when: Date): string {
  const label = f.severity === "drift" ? ageLabel(f, when) : null;
  return label ? ` (${label})` : "";
}

/** Split fix lines into prose and runnable commands ("$ " prefix). */
function fixParts(fix: string[]): { cmd: boolean; text: string }[] {
  return fix.map((l) => (l.startsWith("$ ") ? { cmd: true, text: l.slice(2) } : { cmd: false, text: l }));
}

/** Safe-to-remove leftovers across all checks (never counted as problems). */
export const cleanupOf = (results: CheckResult[]): CleanupItem[] => results.flatMap((r) => r.cleanup ?? []);

export function sizeLabel(kb: number | null): string {
  if (kb === null) return "?";
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

function cleanupLines(results: CheckResult[], home = process.env.HOME ?? ""): string[] {
  const items = cleanupOf(results);
  const stale = items.filter((i) => i.kind === "stale-worktree");
  const missing = items.filter((i) => i.kind === "missing-worktree");
  const where = (i: CleanupItem) => {
    const p = i.host === "local" && home && i.path.startsWith(home + "/") ? "~" + i.path.slice(home.length) : i.path;
    return i.host === "local" ? p : `${i.host}:${p}`;
  };
  const what = (i: CleanupItem) => `${i.branch || `detached ${i.sha.slice(0, 7)}`} (${i.reason})`;
  const out: string[] = [];
  if (stale.length) {
    const w = Math.max(...stale.map((i) => where(i).length));
    const b = Math.max(...stale.map((i) => what(i).length));
    out.push("Cleanup (safe to remove — merged, clean):");
    for (const i of stale) out.push(`  ${where(i).padEnd(w)}   ${what(i).padEnd(b)}   ${sizeLabel(i.sizeKb)}`);
    const total = stale.reduce((n, i) => n + (i.sizeKb ?? 0), 0);
    out.push(`  ${stale.length} stale worktree${stale.length === 1 ? "" : "s"}${total ? `, ${sizeLabel(total)}` : ""} → git worktree remove <path>`);
  }
  if (missing.length) {
    if (out.length) out.push("");
    out.push("Cleanup (worktree directory is gone):");
    for (const i of missing) out.push(`  ${where(i)}${i.branch ? `   ${i.branch}` : ""}`);
    out.push(`  ${missing.length} missing worktree${missing.length === 1 ? "" : "s"} → git worktree prune (run in the repo)`);
  }
  return out;
}

function text(results: CheckResult[], quiet: boolean, when: Date, cleanup: boolean): string {
  const lines = [`git-drift — ${headline(results, when)}  (${when.toISOString().slice(0, 16).replace("T", " ")} UTC)`, ""];
  for (const r of ordered(results, quiet, when)) {
    lines.push(`${ICON[r.status]} ${r.name} [${r.host}] ${r.summary}`);
    for (const f of r.findings) {
      if (r.status !== "ok" || f.severity === "info") {
        lines.push(`    ${f.severity === "info" ? "·" : "•"} ${f.message}${age(f, when)}`);
        for (const item of f.items ?? []) lines.push(`        ${item}`);
        if (f.fix?.length && f.severity === "drift") {
          lines.push(`      → how to fix:`);
          for (const p of fixParts(f.fix)) lines.push(p.cmd ? `          $ ${p.text}` : `          ${p.text}`);
        }
      }
    }
  }
  const cl = cleanup ? cleanupLines(results) : [];
  if (cl.length) lines.push("", ...cl);
  return lines.join("\n") + "\n";
}

function markdown(results: CheckResult[], quiet: boolean, when: Date, cleanup: boolean): string {
  const out = [
    `## git-drift: ${headline(results, when)}`,
    "",
    `_${when.toISOString().slice(0, 16).replace("T", " ")} UTC · ✗ needs action (each one says how to fix it) · ! couldn't check · notes never fail the run_`,
    "",
  ];
  const list = ordered(results, quiet, when);
  const problems = list.filter((r) => r.status !== "ok");
  if (problems.length) {
    out.push("### Needs attention", "");
    for (const r of problems) {
      out.push(`- **${ICON[r.status]} ${r.name}** \`${r.host}\` — ${r.summary}`);
      for (const f of r.findings) {
        out.push(`  - ${f.message}${age(f, when) && ` _${age(f, when).trim()}_`}`);
        if (f.items?.length) out.push("", "    ```", ...f.items.map((i) => "    " + i), "    ```", "");
        if (f.fix?.length && f.severity === "drift") {
          out.push("", "    **How to fix:**", "");
          let block: string[] = [];
          const flush = () => {
            if (block.length) out.push("    ```sh", ...block.map((c) => "    " + c), "    ```", "");
            block = [];
          };
          for (const p of fixParts(f.fix)) {
            if (p.cmd) block.push(p.text);
            else {
              flush();
              out.push(`    ${p.text}`, "");
            }
          }
          flush();
        }
      }
    }
    out.push("");
  }
  const clean = list.filter((r) => r.status === "ok");
  if (clean.length) {
    out.push("### Clean", "", "| Check | Host | Result |", "|---|---|---|");
    for (const r of clean) {
      const notes = r.findings.filter((f) => f.severity === "info").map((f) => f.message).join("; ");
      out.push(`| ${r.name} | ${r.host} | ${(r.summary + (notes && !r.summary.includes(notes) ? ` (${notes})` : "")).replace(/\|/g, "\\|")} |`);
    }
  }
  const cl = cleanup ? cleanupLines(results) : [];
  if (cl.length) out.push("", "### Cleanup", "", "```", ...cl, "```");
  return out.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function html(results: CheckResult[], quiet: boolean, when: Date, cleanup: boolean): string {
  const color: Record<Status, string> = { ok: "#1a7f37", drift: "#b35900", error: "#cf222e" };
  const rows = ordered(results, quiet, when)
    .map((r) => {
      const details = r.findings
        .filter((f) => r.status !== "ok" || f.severity === "info")
        .map((f) => {
          const items = f.items?.length ? `<pre style="margin:4px 0;font-size:12px;background:#f6f8fa;padding:6px;white-space:pre-wrap">${esc(f.items.join("\n"))}</pre>` : "";
          const fix =
            f.fix?.length && f.severity === "drift"
              ? `<div style="margin:6px 0 8px;padding:8px 10px;border-left:3px solid #0969da;background:#f0f6ff"><div style="font-weight:600;margin-bottom:4px">How to fix</div>${fixParts(f.fix)
                  .map((p) => (p.cmd ? `<pre style="margin:4px 0;font-size:12px;background:#fff;border:1px solid #d0d7de;padding:6px;white-space:pre-wrap;word-break:break-all">${esc(p.text)}</pre>` : `<div style="margin:2px 0">${esc(p.text)}</div>`))
                  .join("")}</div>`
              : "";
          const label = age(f, when) && `<span style="color:${isNew(f, when) ? "#cf222e" : "#666"};font-size:12px">${esc(age(f, when))}</span>`;
          return `<div style="margin:4px 0 0 0">${esc(f.message)}${label}${items}${fix}</div>`;
        })
        .join("");
      return `<tr><td style="padding:6px;vertical-align:top;color:${color[r.status]};font-weight:600">${ICON[r.status]}</td><td style="padding:6px;vertical-align:top"><b>${esc(r.name)}</b> <span style="color:#666">${esc(r.host)}</span><div>${esc(r.summary)}</div>${details}</td></tr>`;
    })
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px"><h2 style="margin:0 0 4px">git-drift: ${esc(headline(results, when))}</h2><p style="color:#666;margin:0 0 12px">${when.toISOString().slice(0, 16).replace("T", " ")} UTC · ✗ needs action (each one says how to fix it) · ! couldn't check · notes never fail the run</p><table style="border-collapse:collapse">${rows}</table>${cleanup && cleanupOf(results).length ? `<pre style="margin:12px 0 0;font-size:12px;color:#444;background:#f6f8fa;padding:8px;white-space:pre-wrap">${esc(cleanupLines(results).join("\n"))}</pre>` : ""}</div>\n`;
}

/** `cleanup: false` leaves the Cleanup section out (the email report does). */
export function render(results: CheckResult[], format: Format, quiet = false, when = new Date(), cleanup = true): string {
  switch (format) {
    case "json": {
      const summary = tracked(results) ? { ...counts(results), new: newChecks(results, when) } : counts(results);
      // `cleanup` (flat list across checks) is separate from drift: it never counts in `summary` or the exit code.
      const items = cleanup ? cleanupOf(results) : [];
      const shown = cleanup ? results : results.map(({ cleanup: _c, ...r }) => r);
      return JSON.stringify({ generatedAt: when.toISOString(), summary, ...(items.length ? { cleanup: items } : {}), results: shown }, null, 2) + "\n";
    }
    case "markdown": return markdown(results, quiet, when, cleanup);
    case "html": return html(results, quiet, when, cleanup);
    default: return text(results, quiet, when, cleanup);
  }
}

export function formatFromPath(path: string): Format {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
  return "text";
}
