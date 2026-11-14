// Stale worktrees: finished linked worktrees are a low-key Cleanup list, never drift.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkGit } from "../src/checks/git.js";
import type { GitTarget } from "../src/config.js";
import { counts, render } from "../src/report.js";
import { statusOf } from "../src/types.js";
import { ctxWith, FakeGithub, git, tempDir, tempRepo } from "./helpers.js";

function setup() {
  const { dir: origin, head } = tempRepo();
  const root = tempDir();
  const clone = join(root, "clone");
  git(tempDir(), "clone", "-q", origin, clone);
  const t: GitTarget = { name: "api", type: "git", path: clone, repo: "api" };
  const ctx = ctxWith(new FakeGithub({ "o/api": { sha: head, ref: "main" } }), [t]);
  const wt = (name: string, ...args: string[]) => {
    const p = join(root, name);
    git(clone, "worktree", "add", "-q", ...(args.length ? args : ["-b", name]), p, ...(args.length ? [] : ["origin/main"]));
    return p;
  };
  /** commit a file in `dir` */
  const commit = (dir: string, file: string, msg = file) => {
    writeFileSync(join(dir, file), msg + "\n");
    git(dir, "add", file);
    git(dir, "commit", "-qm", msg);
  };
  /** put `branch`'s patch on origin/main as a squash-style new commit, then refresh origin refs */
  const squashInto = (branch: string) => {
    git(origin, "checkout", "-q", "main");
    writeFileSync(join(origin, "other.txt"), "other\n"); // main moved on, so the pick is a new commit
    git(origin, "add", "other.txt");
    git(origin, "commit", "-qm", "other");
    git(origin, "fetch", "-q", clone, branch);
    git(origin, "cherry-pick", "FETCH_HEAD");
  };
  const sync = () => git(clone, "fetch", "-q", "origin");
  return { origin, clone, root, t, ctx, wt, commit, squashInto, sync };
}

const run = async (s: ReturnType<typeof setup>) => checkGit(s.ctx, s.t);

test("a clean worktree whose branch is merged into main is cleanup, not drift", async () => {
  const s = setup();
  const p = s.wt("feat-a"); // branch at origin/main
  const r = await run(s);
  assert.equal(r.findings.some((f) => f.severity === "drift"), false);
  assert.equal(r.cleanup?.length, 1);
  const c = r.cleanup![0];
  assert.equal(c.kind, "stale-worktree");
  assert.equal(c.reason, "merged");
  assert.equal(c.branch, "feat-a");
  assert.ok(c.path.endsWith("/feat-a") && p.endsWith("/feat-a"));
  assert.ok(typeof c.sizeKb === "number" && c.sizeKb > 0);
  assert.match(c.command, /git worktree remove .*feat-a/);
});

test("a squash-merged (cherry-picked) branch is cleanup: all commits upstream", async () => {
  const s = setup();
  const p = s.wt("feat-sq");
  s.commit(p, "sq.txt");
  s.squashInto("feat-sq");
  s.sync();
  const r = await run(s);
  assert.equal(r.cleanup?.length, 1);
  assert.equal(r.cleanup![0].reason, "all commits upstream");
});

test("uncommitted or untracked edits keep it out of cleanup (and stay drift)", async () => {
  const s = setup();
  const p = s.wt("feat-dirty");
  writeFileSync(join(p, "new.txt"), "x\n"); // untracked counts
  const r = await run(s);
  assert.equal(r.cleanup, undefined);
  assert.ok(r.findings.some((f) => f.code === "worktree-uncommitted" && f.severity === "drift"));
});

test("a branch with unmerged commits is not cleanup", async () => {
  const s = setup();
  const p = s.wt("feat-wip");
  s.commit(p, "wip.txt");
  const r = await run(s);
  assert.equal(r.cleanup, undefined);
});

test("a locked worktree is not cleanup", async () => {
  const s = setup();
  const p = s.wt("feat-locked");
  git(s.clone, "worktree", "lock", p);
  assert.equal((await run(s)).cleanup, undefined);
});

test("a detached worktree is cleanup only when its HEAD is in main", async () => {
  const s = setup();
  const merged = s.wt("det-merged", "--detach");
  const ahead = s.wt("det-ahead", "--detach");
  s.commit(ahead, "ahead.txt");
  const r = await run(s);
  assert.equal(r.cleanup?.length, 1);
  assert.equal(r.cleanup![0].branch, "");
  assert.ok(r.cleanup![0].path.endsWith("/det-merged") && merged.endsWith("/det-merged"));
});

test("a worktree whose directory is gone gets a prune suggestion", async () => {
  const s = setup();
  const p = s.wt("feat-gone");
  rmSync(p, { recursive: true });
  const r = await run(s);
  assert.equal(r.cleanup?.length, 1);
  assert.equal(r.cleanup![0].kind, "missing-worktree");
  assert.match(r.cleanup![0].command, /git worktree prune/);
});

test("cleanup never changes status, exit counts, headline, json summary; --no-cleanup skips it", async () => {
  const s = setup();
  s.wt("feat-a");
  const r = await run(s);
  assert.equal(statusOf(r.findings), "ok");
  const result = { name: "api", type: "git", host: "local", status: statusOf(r.findings), summary: r.summary, findings: r.findings, cleanup: r.cleanup, ms: 1 };
  assert.deepEqual(counts([result]), { ok: 1, drift: 0, error: 0 });
  const text = render([result], "text");
  assert.match(text, /all 1 checks clean/);
  assert.match(text, /Cleanup \(safe to remove — merged, clean\):/);
  assert.match(text, /feat-a \(merged\)/);
  assert.match(text, /1 stale worktree.* → git worktree remove <path>/);
  const json = JSON.parse(render([result], "json"));
  assert.equal(json.summary.drift, 0);
  assert.equal(json.cleanup.length, 1);
  assert.match(render([result], "markdown"), /### Cleanup/);
  assert.match(render([result], "html"), /Cleanup/);
  // email body leaves it out
  assert.doesNotMatch(render([result], "text", false, new Date(), false), /Cleanup/);
  assert.equal(JSON.parse(render([result], "json", false, new Date(), false)).cleanup, undefined);
  // --no-cleanup
  assert.equal((await checkGit({ ...s.ctx, cleanup: false }, s.t)).cleanup, undefined);
  // a repo with no extra worktrees has no cleanup key at all
  const lone = setup();
  assert.equal((await run(lone)).cleanup, undefined);
});
