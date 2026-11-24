---
name: reproducing-prs
description: 'Reproduces bugs on main (Case A), proves fixes comparatively on a PR or feature branch (Case B) in a live browser with a side-by-side fixture, and completes PR delivery when authoring fixes. Use when asked to reproduce a bug or PR locally, demonstrate a before/after fix side-by-side, or fix a bug and update a PR. Don''t use for read-only PR reviews or author feedback (use pr-review-browser-validation).'
---
# Reproducing & Verifying PRs Comparatively

## Overview

Simply reading a diff or running unit tests misses interaction bugs, CSS cascade overrides, and Shadow DOM event issues. Every comparative verification proves two states on the **exact same minimal fixture**:
1. **Case A (`main`):** Reproduce the bug on the base branch (for brand-new features with no baseline bug, capture the pre-feature baseline state).
2. **Case B (PR / fix branch):** Prove the issue is resolved interactively and visually, with zero side effects.

## The 4-Phase Protocol

### Phase 1: Isolate Case A (`main`) & Stash Baseline Bundle

1. **Check out `main` and build the browser bundle:**
   `git checkout main && npm run build:bundle` (fall back to `npm run build` if no bundle-only script exists).
2. **Create the minimal reproduction fixture:**
   Craft the smallest trace JSON, payload, or DOM setup that isolates the variable under test.
3. **Mandatory Gate — Verify Case A fails first:**
   Run the fixture on `main` in a real browser and confirm the bug actually occurs (thrown error, broken visual state, or failed interaction). For bug fixes, if `main` behaves normally, **stop and fix the fixture** before touching the PR branch.
4. **Stash `main`'s bundle inside `demo/`:**
   Subsequent builds wipe `dist/`. Copy the built baseline bundle (and any sourcemap/CSS assets if separate) into `demo/.repro-pr-<num>/` (e.g. `demo/.repro-pr-<num>/log2trace-main.js`) so the demo server can serve Case A alongside Case B without `404`s.

### Phase 2: Validate Case B (PR / Fix Branch) in a Real Browser

1. **Check out the PR/fix branch safely and build the bundle:**
   - Local or tracked branch: `git checkout <branch> && npm run build:bundle`
   - Remote PR ref: `git fetch origin pull/<num>/head:pr-<num> && git checkout pr-<num> && npm run build:bundle`
2. **Run the identical fixture from Phase 1** in a real headed browser (e.g. Chrome or Playwright `channel: 'chrome', headless: false` with `console` and `pageerror` listeners attached before navigation).
3. **Mandatory Gate — Interactive & Visual Verification:**
   - **Real input & hit-testing:** Test actual clicks, hover, drag, and wheel-zoom; verify `pointer-events`, z-index stacking, and Shadow DOM event retargeting.
   - **Rendered & computed truth:** Inspect `shadowRoot`, `getComputedStyle`, and visual screenshots—never rely on unit tests or shallow DOM properties alone.
   - **Neighbor regression check:** Confirm adjacent views, controls, console warnings, and rerender counts stay clean.

### Phase 3: Side-by-Side Visual Demonstration

For UI or behavioral changes, build a live split comparison:
1. Copy `templates/side-by-side.html` (from this skill's directory) to `demo/reproduce-pr-<num>.html`. Wire `FRAME_A_URL` to a minimal frame in `demo/.repro-pr-<num>/` importing `./log2trace-main.js` and `FRAME_B_URL` to an identical frame importing `/dist/log2trace.js`.
2. Confirm the demo server responds at `http://localhost:3000`, then launch for the current environment:
   - **Local desktop:** Open in the user's desktop browser (`Start-Process` on Windows, `open` on macOS, `xdg-open` on Linux). Never run headless checks and claim a desktop window was opened.
   - **Remote / cloud VM:** Run the demo server as a background daemon (`http://localhost:3000/reproduce-pr-<num>.html`), verify both panes in headed Chrome, and inspect screenshots.
3. **Present concise comparison notes:**
   - **Case A (Left / Top):** Exact observed bug on `main`.
   - **Case B (Right / Bottom):** Exact resolved behavior on the PR branch.

### Phase 4: PR Delivery (Only When Code Was Modified)

Skip this phase if you only reproduced or demonstrated an existing PR without changing code. Do not run `lint`, `typecheck`, or unit `test` suites locally—Husky hooks and GitHub Actions run automated checks automatically.

When you authored or modified code to fix the bug:
1. **Commit and push clean changes:**
   Follow `CONTRIBUTING.md` (Chris Beams' 7 rules) and push to the PR branch, excluding temporary repro files (`demo/reproduce-pr-*.html`, `demo/.repro-pr-*`).
2. **Update the GitHub PR description:**
   Follow `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` (delete non-applicable optional sections, keep the description shorter than the diff itself, and fact-check every technical claim against source code).

## Gotchas

- `demo/server.js` serves `/dist/` and `/docs/` from the repo root and everything else from `demo/`; avoid URL query strings (`?case=a`) on static paths when the server maps `req.url` directly to disk.
- Author CSS (`display: flex`, `display: block`) overrides browser `[hidden]`—always verify `getComputedStyle` and rendered visibility.
- `git checkout <branch>` and `gh pr checkout` can fail on single-branch clones; fetch `pull/<num>/head` explicitly and chain with `&&` so a failed checkout never builds the wrong branch.
- Remove temporary `demo/reproduce-pr-*.html` and `demo/.repro-pr-*` artifacts once the user finishes reviewing (or when cleaning up), and never stage or commit them.
