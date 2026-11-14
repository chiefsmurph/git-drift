/** "drift" findings make a check fail; "info" findings are reported but never fail it. */
export type Severity = "drift" | "info";

export type Status = "ok" | "drift" | "error";

export interface Finding {
  severity: Severity;
  /** Stable machine-readable kind (e.g. "uncommitted", "files-differ") for scripts and AI agents. */
  code?: string;
  message: string;
  /** Optional detail lines (file paths, git status lines, command output). */
  items?: string[];
  /** How to resolve it: plain lines, and commands prefixed with "$ ". */
  fix?: string[];
  /** With --evidence: read-only context for deciding the fix (diffs, commit logs, dates). Secrets redacted. */
  evidence?: string[];
  /** When this problem was first seen (ISO), from the state file. Equal to the run's time = new. */
  firstSeen?: string;
}

/**
 * Something that is safe to delete, not a problem: reported in its own low-key Cleanup section. It never
 * changes a check's status, the exit code, the headline or --notify.
 */
export interface CleanupItem {
  /** "stale-worktree": merged/upstream and clean. "missing-worktree": directory gone, `git worktree prune`. */
  kind: "stale-worktree" | "missing-worktree";
  /** the repo's path */
  repo: string;
  host: string;
  /** the worktree path */
  path: string;
  /** branch name; empty when HEAD is detached */
  branch: string;
  sha: string;
  /** "merged", "all commits upstream" or "directory missing" */
  reason: string;
  /** disk used (KB, `du -sk`); null when unknown */
  sizeKb: number | null;
  /** the command that removes it (git-drift never runs it) */
  command: string;
}

export interface CheckResult {
  name: string;
  type: string;
  host: string;
  status: Status;
  /** One line describing the outcome. */
  summary: string;
  findings: Finding[];
  /** Safe-to-remove leftovers (never drift). Absent when there are none. */
  cleanup?: CleanupItem[];
  ms: number;
}

export function statusOf(findings: Finding[]): Status {
  return findings.some((f) => f.severity === "drift") ? "drift" : "ok";
}
