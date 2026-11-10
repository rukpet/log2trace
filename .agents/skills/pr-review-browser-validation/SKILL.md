---
name: pr-review-browser-validation
description: Review a GitHub PR for a web-component/frontend repo, validate behavior in headless Chromium on a remote VM, and produce copy-pasteable author feedback. Use when asked to "review PR #N", "test in the browser", "review again", or "give me feedback text for the author".
---
# PR review with headless browser validation

## 1. Gather context
- `gh pr view N --json title,body,headRefName,files,state` and `gh pr diff N`.
- Check out via the PR ref (branch names often fail on forks/odd refspecs):
  `git fetch origin pull/N/head:prN && git checkout prN`.
  For a re-review, fetch into a new local name (`prNnew`) and `git log prN..prNnew` + `git diff prN prNnew` to see only the new commit.
- Install deps with `npm ci` BEFORE running anything. Do NOT chain `npm ci` with `;` after a failed checkout (you'll test the wrong branch). Run steps separately.

## 2. Automated checks
Run `npm run check`, `npm run lint`, `npm test`, and the build (`npm run build:bundle`). Long commands go to background; check status with `manage_task` or `sleep` + read the task log. Don't poll in tight loops.

## 3. Browser validation (no GUI on the VM)
- Tell the user up front that only headless validation is possible; ask once if unsure.
- Serve the repo's demo server with `IsDaemon: true` (it dies if the environment restarts; re-check with `curl -s -o /dev/null -w '%{http_code}' localhost:PORT`).
- Screenshots: `chromium --headless --no-sandbox --disable-gpu --window-size=1400,900 --virtual-time-budget=6000 --screenshot=/tmp/shots/x.png URL`, then view the PNG.
- Behavior probes: write a temporary `demo/probe-prN.html` that loads the bundle, manipulates the DOM (add/remove/change attributes, click tabs), and writes results into `<pre id="out">`; read it with `chromium ... --dump-dom | sed -n '/<pre id="out">/,/<\/pre>/p'`. To count console warnings, wrap `console.warn` before the module loads. DELETE the probe file afterwards and confirm `git status` is clean.
- Test: defaults/fallbacks, ordering, labels, dynamic add/remove/attribute changes, state preserved on unrelated changes, removed/deprecated attributes (does the old API fail silently?), unknown/duplicate inputs, and per-element options.
- If possible compare against `main` (baseline) to show before/after.

## 4. Review heuristics
- Silent breaking changes (removed attributes/features) need a warning + migration note.
- Removed features must be called out in the PR description.
- Duplicate notification paths (observer + attributeChangedCallback).
- Side-effects inside hot/pure functions (e.g. a warning in a getter-called parser => console spam). Verify by counting in the browser.
- Over-broad rerenders; test-only guards leaking into production code.

## 5. Deliver
- Concise summary: checks results, browser findings, numbered issues marked blocking vs follow-up.
- When asked for feedback for the author, give it as a single copy-pasteable plain-text block (```text fence, no markdown formatting inside), numbered, with blocking items stated explicitly. Offer `gh pr review N` to post it; don't post without being asked.
- Don't modify the PR or repo unless asked.
