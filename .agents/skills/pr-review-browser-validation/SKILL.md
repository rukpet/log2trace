---
name: pr-review-browser-validation
description: Reviews a GitHub PR for a web-component/frontend repo, validates its behavior in headless Chromium, and writes copy-pasteable feedback for the author. Use when asked to "review PR #N", "validate/test it in the browser", "review again", or "give me feedback for the author". Don't use for fixing a bug or authoring a PR (use reproducing-prs), or for non-web repos or non-GitHub hosts (GitLab, Gerrit).
---
# PR review with browser validation

## Goals
- Understand what the PR claims to change and review the diff against it.
- Prove it works: automated checks pass, and the real behavior is verified in a browser, not just by reading code.
- Hand the author actionable feedback they can paste as-is.

## What to verify
- **Automated checks:** typecheck, lint, tests and build all pass on the PR head.
- **Behavior in a browser:** the changed feature works end to end, including defaults and fallbacks, dynamic changes, unchanged state on unrelated changes, and invalid or duplicate input. Prefer headless validation and say so, since there is no GUI on the VM.
- **Baseline:** where practical, compare against `main` to show what changed.
- **Cleanliness:** temporary test artifacts are removed and the working tree is left clean.

## What to look for in review
- Breaking changes that fail silently (need a warning and a migration note).
- Removed features not called out in the PR description.
- Redundant notification or update paths.
- Side effects in frequently called code (e.g. a warning that fires on every read).
- Over-broad rerenders and test-only code leaking into production.

## Gotchas
- Fetch the PR via `refs/pull/N/head`; `gh pr checkout` can fail on branch refspecs.
- Don't chain install, check and test with `;` after a checkout that may have failed, or the wrong branch gets tested.
- The demo server dies when the environment restarts; confirm it responds before testing.
- Remove temporary probe pages and confirm `git status` is clean.
- Verify side effects (such as warning counts) in the browser; reading the code missed a console-spam bug.

## Blocked steps
If a step can't be done (no browser, install fails), say so and report it as unverified. Never claim it passed.

## Re-reviews
Look only at what changed since the last review and confirm each earlier finding is fixed, still open, or newly introduced.

## Output
Do not modify or comment on the PR unless asked. Give a concise summary of check results and browser findings, then, on request, author feedback as one plain-text block:

```text
<one line on what was verified>

Blocking
1. <issue and the fix wanted>

Follow-ups
2. <issue>
```
