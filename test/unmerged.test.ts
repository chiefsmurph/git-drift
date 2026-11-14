// Branches that were pushed but never merged into the default branch.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkGit } from "../src/checks/git.js";
import type { GitTarget } from "../src/config.js";
import type { Finding } from "../src/types.js";
import { render } from "../src/report.js";
import { ctxWith, FakeGithub, git, tempDir, tempRepo } from "./helpers.js";

const DAY = 86_400;

/** Commit a file on a new branch of `origin`, dated `ageDays` ago. */
function pushBranch(origin: string, name: string, file: string, ageDays: number, subject = `work on ${name}`) {
  const when = `${Math.floor(Date.now() / 1000) - ageDays * DAY} +0000`;
  process.env.GIT_COMMITTER_DATE = when;
  process.env.GIT_AUTHOR_DATE = when;
  try {
    git(origin, "checkout", "-q", "-b", name, "main");
    writeFileSync(join(origin, file), `${name}\n`);
    git(origin, "add", file);
    git(origin, "commit", "-qm", subject);
    git(origin, "checkout", "-q", "main");
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
    delete process.env.GIT_AUTHOR_DATE;
  }
}

function setup(target: Partial<GitTarget> = {}, extra: Record<string, unknown> = {}) {
  const { dir: origin, head } = tempRepo();
  const clone = join(tempDir(), "clone");
  git(origin, "rev-parse", "HEAD");
  const t: GitTarget = { name: "api", type: "git", path: clone, repo: "api", ...target };
  const ctx = ctxWith(new FakeGithub({ "o/api": { sha: head, ref: "main" } }), [t], extra);
  const sync = () => git(tempDir(), "-C", clone, "fetch", "-q", "origin");
  git(tempDir(), "clone", "-q", origin, clone);
  return { origin, clone, t, ctx, sync };
}

const unmerged = (r: { findings: Finding[] }) => r.findings.find((f) => f.code === "unmerged-branches");

test("a pushed branch that never reached main is flagged, with count, date and tip subject", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "fix/old-bug", "fix.txt", 42, "the 6-week-old fix");
  sync();
  const f = unmerged(await checkGit(ctx, t)) as Finding;
  assert.ok(f, "finding present");
  assert.equal(f.severity, "drift");
  assert.match(f.message, /1 branch was pushed to GitHub but never merged into main/);
  assert.match(f.items![0], /^fix\/old-bug — 1 commit not in main, last commit \d{4}-\d\d-\d\d \(42 days ago\): the 6-week-old fix$/);
  assert.ok(f.fix!.some((l) => l.includes("git log --oneline origin/main..origin/fix/old-bug")));
});

test("a squash-merged (or cherry-picked) branch is not flagged", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "feat/done", "done.txt", 30);
  // main gets the same patch as a new commit, as a squash merge or cherry-pick would
  git(origin, "cherry-pick", "feat/done");
  sync();
  assert.equal(unmerged(await checkGit(ctx, t)), undefined);
});

test("a young branch is ignored; --unmerged-days / minAgeDays change the cutoff", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "feat/wip", "wip.txt", 2);
  sync();
  assert.equal(unmerged(await checkGit(ctx, t)), undefined);
  assert.ok(unmerged(await checkGit({ ...ctx, unmergedDays: 0 }, t)));
  assert.ok(unmerged(await checkGit(ctx, { ...t, unmerged: { minAgeDays: 1 } })));
});

test("dependabot and renovate branches are ignored but counted in a note", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "dependabot/npm_and_yarn/x-1.2", "a.txt", 60);
  pushBranch(origin, "renovate/y-2.x", "b.txt", 60);
  sync();
  const r = await checkGit(ctx, t);
  assert.equal(unmerged(r), undefined);
  const note = r.findings.find((f) => f.code === "unmerged-bot-branches");
  assert.equal(note?.severity, "info");
  assert.match(note!.message, /^2 bot branches/);
  assert.equal(r.findings.some((f) => f.severity === "drift"), false);
  // bot patterns are configurable
  const r2 = await checkGit(ctx, { ...t, unmerged: { ignoreBots: [] } });
  assert.match(unmerged(r2)!.message, /^2 branches were pushed/);
});

test("ignore globs, unmerged:false and checkBranches:false silence it", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "archive/old", "o.txt", 90);
  pushBranch(origin, "keep/me", "k.txt", 90);
  sync();
  const r = await checkGit(ctx, { ...t, unmerged: { ignore: ["archive/*"] } });
  assert.match(unmerged(r)!.items!.join("\n"), /keep\/me/);
  assert.doesNotMatch(unmerged(r)!.items!.join("\n"), /archive\/old/);
  assert.equal(unmerged(await checkGit(ctx, { ...t, unmerged: false })), undefined);
  assert.equal(unmerged(await checkGit(ctx, { ...t, checkBranches: false })), undefined);
  const viaDefaults = ctxWith(ctx.gh, [t], { defaults: { unmerged: false } });
  assert.equal(unmerged(await checkGit(viaDefaults, t)), undefined);
});

test("works offline on the last-fetched refs (never fetches), and a repo with no remote is fine", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "feat/a", "a.txt", 20);
  sync();
  pushBranch(origin, "feat/b", "b.txt", 20); // pushed after the last fetch: not visible, and not fetched for us
  const f = unmerged(await checkGit(ctx, t)) as Finding;
  assert.match(f.message, /^1 branch was/);
  const { dir, head } = tempRepo();
  const lone: GitTarget = { name: "lone", type: "git", path: dir, repo: "api" };
  const r = await checkGit(ctxWith(new FakeGithub({ "o/api": { sha: head } }), [lone]), lone);
  assert.deepEqual(r.findings, []);
});

test("JSON report carries the code, severity, items and fix; text report explains it", async () => {
  const { origin, t, ctx, sync } = setup();
  pushBranch(origin, "fix/old-bug", "fix.txt", 42);
  sync();
  const out = await checkGit(ctx, t);
  const result = { name: "api", type: "git", host: "local", status: "drift" as const, summary: out.summary, findings: out.findings, ms: 1 };
  const json = JSON.parse(render([result], "json"));
  const f = json.results[0].findings.find((x: { code: string }) => x.code === "unmerged-branches");
  assert.equal(f.severity, "drift");
  assert.equal(json.summary.drift, 1);
  assert.match(f.items[0], /^fix\/old-bug — 1 commit/);
  assert.ok(f.fix.length > 0);
  assert.match(render([result], "text"), /never merged into main/);
  assert.match(render([result], "markdown"), /never merged into main/);
});
