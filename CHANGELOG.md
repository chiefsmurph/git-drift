# Changelog

Every release is a patch version.

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
