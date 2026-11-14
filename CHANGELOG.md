# Changelog

Every release is a patch version.

## 0.4.3

- New **Cleanup** section: linked worktrees that are finished and safe to remove. A worktree is listed when it
  is not locked, has had no activity for 24 hours (newest of its index file, HEAD file and HEAD commit date; `--cleanup-min-age <hours>`, 0 = off), has nothing uncommitted (untracked files count), and its HEAD is already in the default branch
  on GitHub, or (on a branch) every commit is already upstream per `git cherry` (squash and cherry-pick merges).
  Detached worktrees count only when their HEAD is in the default branch. Each entry shows repo, path, branch
  (or detached sha), why it is safe and its disk size (`du -sk`, 20 s limit, `?` on failure), plus a total.
  Worktrees whose directory is gone are listed with `git worktree prune`.
- Cleanup is not drift: it never changes a check's status, the exit code, the headline, or `--notify`, and it
  is left out of the email. In `-f json` it is a separate top-level `cleanup` array (and `cleanup` on the
  result); existing fields are unchanged. `--no-cleanup` hides it and skips the probe.
- Works for `scan` and configured `git` checks, locally and over `--ssh`. git-drift only prints the command; it
  removes nothing. Reads last-fetched refs, never fetches.
- The `/git-drift:check` skill offers to remove stale worktrees, with explicit approval (never `--force`).

## 0.4.2

- New finding `unmerged-branches`: a branch pushed to `origin` whose patches never reached the default branch
  (`git cherry`, so squash-merged and cherry-picked work is not flagged). Reports the branch, last commit date,
  unique commit count and tip subject. Drift when older than 7 days (`--unmerged-days`, or `unmerged.minAgeDays`).
- `dependabot/*` and `renovate/*` are ignored by default and counted in an `unmerged-bot-branches` note.
  `unmerged.ignore` accepts a branch name or glob; `unmerged: false` turns the check off.
- Reads the last-fetched remote refs. It never runs `git fetch`, so it works offline.

## 0.4.1

- The email setup says exactly what a report contains (a failed command check's output tail too).

## 0.4.0

- Email the report: `git-drift notify pingpigeon`, `--notify`, `--notify-always`.
