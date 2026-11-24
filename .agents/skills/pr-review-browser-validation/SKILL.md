---
name: pr-review-browser-validation
description: 'Reviews a GitHub PR for a web-component or frontend repo, validates real behavior in a live browser, and writes copy-pasteable feedback for the author. Use when asked to "review PR #N", "validate/test it in the browser", "review again", or "give me feedback for the author". Don''t use for fixing a bug or authoring a PR (use reproducing-prs), or for non-web repos or non-GitHub hosts (GitLab, Gerrit).'
---
# PR review with browser validation

## Goals
- Understand what the PR claims to change and review the diff against it.
- Prove it works in a real browser—both interactively and visually—not by reading code or re-running CI suites.
- Hand the author actionable feedback they can paste as-is.

## What to verify
- **Skip local automated checks:** Do not run lint, typecheck, or unit tests locally—CI runs those automatically. Only build the bundle needed to serve the browser (glance at `gh pr checks` only to note if CI is already red).
- **Real browser (headed Chrome):** Drive a real headed browser (e.g. Playwright `channel: 'chrome', headless: false` or the interactive browser tool). Fall back to headless only when no display/X server exists, and say so explicitly.
- **Interactive & rendered behavior:** Turn the PR's claims and diff risks into live probes:
  - End-to-end happy path, defaults, and attribute/child removal fallbacks.
  - Real user input (click, wheel, hover, keyboard), `shadowRoot` output, and `getComputedStyle`—never rely on shallow DOM properties like `.hidden` alone.
  - Initial HTML upgrade vs. dynamic DOM mutations, confirming unrelated state stays unchanged.
  - Invalid or duplicate inputs, `console` warnings/errors, `pageerror` exceptions, and microtask call/rerender counts.
- **Visual inspection:** Capture and inspect screenshots of key states (initial render, post-interaction, fallback/edge state) to catch clipping, overlap, contrast, or Canvas/layout glitches that DOM assertions miss.
- **Targeted baseline:** Compare against `main` only when needed to tell a new regression from pre-existing behavior or verify a behavioral/perf delta.
- **Cleanliness:** Keep scratch scripts in `/tmp` (prefer `page.route()` over writing temporary HTML into the repo), restore the original git ref, and confirm `git status` is clean.

## What to look for in review
- Breaking changes that fail silently (need a warning and a migration note).
- Removed features not called out in the PR description.
- Redundant notification or update paths.
- Side effects in frequently called code (e.g. a warning that fires on every read).
- Over-broad rerenders and test-only code leaking into production.

## Gotchas
- Fetch and detach via `git fetch origin pull/<N>/head && git checkout --detach FETCH_HEAD`; `gh pr checkout` can fail on branch refspecs, and chaining with `;` risks testing the wrong branch if fetch fails.
- Attach `console` and `pageerror` listeners before navigation; reading code alone misses console-spam and microtask errors.
- The demo/dev server dies when the environment restarts; confirm it serves the freshly built bundle before testing.
- Never leave probe pages in the repo; confirm `git status` is clean when done.

## Blocked steps
If browser validation can't run (no browser, bundle build or server fails), stop and report it as **unverified** with the exact blocker. Never claim it passed from code inspection.

## Re-reviews
Look only at what changed since the last review and confirm each earlier finding is fixed, still open, or newly introduced.

## Output
Do not modify or comment on the PR on GitHub unless asked. Give a concise summary of diff and browser findings (omit CI boilerplate unless CI is failing), then, on request, author feedback as one plain-text block:

```text
<one line on what was verified in the browser>

Blocking
1. <issue and the fix wanted>

Follow-ups
2. <issue>
```
