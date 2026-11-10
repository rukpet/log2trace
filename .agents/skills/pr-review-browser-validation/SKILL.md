---
name: pr-review-browser-validation
description: Review a GitHub PR for a web-component/frontend repo, validate behavior in headless Chromium on a remote VM, and produce copy-pasteable author feedback. Use when asked to "review PR #N", "test in the browser", "review again", or "give me feedback text for the author".
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

## Re-reviews
Look only at what changed since the last review and confirm each earlier finding is fixed, still open, or newly introduced.

## Output
- A concise summary: check results, browser findings, numbered issues marked blocking or follow-up.
- On request, author feedback as one copy-pasteable plain-text block, numbered, with blocking items stated explicitly.
- Do not modify or comment on the PR unless asked.
