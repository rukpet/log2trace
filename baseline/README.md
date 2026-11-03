# Baseline: the current implementation, before the rewrite

Numbers taken from the **unmodified** `<trace-visualizer>` with the harness in `demo/perf.html`
(`?impl=current`) and the generator in `demo/perf-gen.js`, so the new renderers can be compared against them
scenario by scenario. Nothing in `src/` was touched to take them.

| | |
|---|---|
| Measured commit | `38df9e68d022a33f6512dcf6fdb3e054e8aecb4a` (`main`, version 1.0.0-RC2) |
| Bundle | `dist/log2trace.min.js`, 67,597 bytes, sha256 `bce764d8513bf7a68d4b2686a652ef4241ccef6d52f06aa1efa46d424f5ffbf5` (`npm ci --ignore-scripts`, `npm run build:bundle`) |
| Harness | `demo/perf.html` sha256 `a7e8e8c099d1955bcc0287ab269b13259b9f641006a8c39ea51231c8c3c3ab8e` when the runs were taken (the committed file, `41e8eb62b405db043542278b5483957e8ad4ab42d445444616c0efad5a0f3361`, differs only in one corrected comment); `demo/perf-gen.js` sha256 `c98882b3b8a315491837153de686c90876c629c1a0be816047f9310573507917` |
| Dataset | `generateTrace({ n, seed: 1 })`: one trace, mean depth 9, max 14 plus two chains to 30, 500 distinct names, ≈2 events per span plus 0.1% log-heavy spans (500–2000 events, see caveats). `n` = 1K, 5K, 10K, 20K and 50K; at 20K and 50K zoom and pan did not finish and only the other scenarios were run |
| Captured | 2026-11-03 |

## Results

Medians over the runs of each size (1K: 3 runs, 5K: 2 runs, 10K, 20K and 50K: 1 run each; at 20K and 50K only the
non-zoom scenarios were run, `–` means not run or not reached; per-run files are listed at the end, `summary.json`
has every value). All times are milliseconds. "Frame p50 / p95 / max" are differences between
`requestAnimationFrame` timestamps while one synthetic input is applied per frame, so 16.7 means a smooth 60 Hz;
"action→frame" is the time from the start of a discrete action until the next frame has been produced. A scenario stops
after its 60 s budget, so on big traces some samples are smaller than requested (frames done are shown for zoom
and pan, operations done for collapse; the other cases are in the JSON, where such a scenario has `status: timeout`
and the counts of what ran); `DNF` means the run did not finish.

### Medians over runs

| Metric | 1K | 5K | 10K | 20K | 50K |
|---|---:|---:|---:|---:|---:|
| Runs (usable / total) | 3 / 3 | 2 / 2 | 1 / 1 | 1 / 1 | 1 / 1 |
| Spans / events | 1,000 / 4,013 | 5,000 / 16,176 | 10,000 / 31,171 | 20,000 / 67,068 | 50,000 / 152,284 |
| DOM elements after first render | 12,060 | 56,223 | 111,218 | 227,115 | 552,331 |
| First render: JS sync (ms) | 90 | 493 | 1,251 | 2,371 | 7,616 |
| First render: to first frame (ms) | 141 | 846 | 2,059 | 3,757 | 11,661 |
| Wheel zoom: frame p50 / p95 / max (ms) | 250 / 317 / 367 | 1,317 / 1,617 / 3,650 | 3,450 / 14,317 / 14,317 | DNF | DNF |
| Wheel zoom: frames done of 120 / % over 33 ms | 120 / 99% | 44 / 100% | 15 / 100% | DNF | DNF |
| Drag pan (zoom reached): frame p50 / p95 / max (ms) | 33 / 34 / 83 (10×, 120 fr.) | 108 / 157 / 675 (10×, 120 fr.) | 183 / 283 / 733 (10×, 120 fr.) | DNF | DNF |
| Hover: frame p50 / p95 / max (ms) | 17 / 17 / 21 | 33 / 75 / 105 | 67 / 133 / 234 | 150 / 317 / 417 | 367 / 433 / 750 |
| Select 50 rows: action→frame p50 / p95 / max (ms) | 27 / 55 / 63 | 71 / 125 / 208 | 204 / 347 / 448 | 304 / 701 / 726 | 657 / 828 / 1,485 |
| Select 2000-event span: ms / detail DOM nodes | 696 / 50,051 | 1,050 / 50,045 | 2,472 / 50,051 | 990 / 50,045 | 1,070 / 50,051 |
| Hover after zoom: frame p50 / p95 / max (ms) | 33 / 34 / 53 | 75 / 92 / 148 | 117 / 167 / 217 | – | – |
| Select after zoom (12 rows): action→frame p50 / p95 / max (ms) | 73 / 117 / 117 | 1,008 / 1,175 / 1,175 | 3,599 / 4,135 / 4,135 | – | – |
| Select 2000-event span after zoom (ms) | 914 | 2,649 | 4,913 | – | – |
| Resize: frame p50 / p95 / max (ms) | 33 / 50 / 50 | 150 / 200 / 259 | 316 / 566 / 633 | 683 / 1,267 / 1,400 | 1,483 / 1,917 / 1,967 |
| Collapse subtree p50 / expand p50 (ms) [ops done] | 136 / 197 [46] | 538 / 994 [46] | 1,286 / 2,014 [35] | 2,264 / 4,467 [18] | 9,038 / 10,984 [7] |
| collapseAll / expandAll p50 (ms) | 15 / 112 | 30 / 607 | – / – | – / – | – / – |
| Filter selective / broad / clear p50 (ms) | 12 / 21 / 90 | 39 / 154 / 886 | 74 / 354 / 2,152 | 469 / 1,050 / 3,992 | 456 / 3,602 / 25,123 |
| Scroll smooth: frame p50 / p95 / max (ms) | 17 / 17 / 18 | 33 / 58 / 133 | 83 / 150 / 733 | 167 / 283 / 517 | 434 / 700 / 1,350 |
| Scroll jumps: frame p50 / p95 / max (ms) | 17 / 17 / 17 | 57 / 108 / 199 | 117 / 200 / 467 | 233 / 417 / 634 | 567 / 850 / 967 |
| Long tasks, all scenarios: count / total ms | 236 / 39,705 | 663 / 179,871 | 1,127 / 348,861 | 781 / 231,600 | 561 / 383,379 |
| JS heap (MB): data / after render / end | 7 / 10 / 6 | 12 / 15 / 15 | 25 / 24 / 25 | 50 / 71 / 64 | 144 / 235 / 89 |
| Wall time per run (s) | 74 | 215 | 375 | 248 | 419 |

### Run-to-run spread (min–max over runs)

| Metric | 1K | 5K | 10K | 20K | 50K |
|---|---:|---:|---:|---:|---:|
| First render JS (ms) | 73–113 | 448–537 | 1,251–1,251 | 2,371–2,371 | 7,616–7,616 |
| Wheel zoom frame p50 (ms) | 233–267 | 1,266–1,367 | 3,450–3,450 | – | – |
| Drag pan frame p50 (ms) | 33–33 | 83–133 | 183–183 | – | – |
| Hover frame p50 (ms) | 17–17 | 33–33 | 67–67 | 150–150 | 367–367 |
| Select p50 (ms) | 26–30 | 70–72 | 204–204 | 304–304 | 657–657 |
| Select 2000-event span (ms) | 696–738 | 847–1,254 | 2,472–2,472 | 990–990 | 1,070–1,070 |
| Resize frame p50 (ms) | 33–83 | 150–150 | 316–316 | 683–683 | 1,483–1,483 |
| Collapse p50 (ms) | 124–194 | 534–543 | 1,286–1,286 | 2,264–2,264 | 9,038–9,038 |
| Expand p50 (ms) | 192–358 | 969–1,019 | 2,014–2,014 | 4,467–4,467 | 10,984–10,984 |
| Filter clear p50 (ms) | 85–103 | 884–889 | 2,152–2,152 | 3,992–3,992 | 25,123–25,123 |
| Scroll jumps p50 (ms) | 17–17 | 50–65 | 117–117 | 233–233 | 567–567 |
| CPU probe at start (ms, 2M-iteration loop) | 3.8–4.6 | 3.9–8 | 4–4 | 4.1–4.1 | 3.8–3.8 |
| Pipeline probe p95 at start (ms) | 16.8–16.9 | 16.9–17 | 17–17 | 16.8–16.8 | 17.2–17.2 |

### Did not finish

| File | Size | What happened |
|---|---:|---|
| `current-n20000.zoom-dnf.json` | 20,000 spans | wheel-zoom: Did not finish by the 60 s rule: the worker saw no heartbeat for 60 s during the first wheel-zoom steps. The page recovered; wheel-zoom then ended on its own 60 s budget about 145 s after it started (frame interval p50 10.2 s). The tab was closed by hand when drag-pan began, because the renderer had grown to about 5 GB. |
| `current-n50000.zoom-dnf.json` | 50,000 spans | wheel-zoom: Did not finish by the 60 s rule: first render completed (10.8 s of synchronous JS, 15.8 s to the first frame), then the worker saw no heartbeat for 60 s while the first wheel-zoom step was running; at the time the tab was closed (more than 3 minutes into that step) the page was still busy on one core with no frame produced. |

### `demo/benchmark.html`, 10K flat (one click, as asked)

`benchmark.html` takes a single sample per cell (`WARMUP=0`, `SAMPLES=1`), so it is noisy; N logs make N/2 spans, so
the 10 000 column is a 5 000-span flat trace. The ✓/✗ come from the targets in that page.

| Stage | 100 | 500 | 1,000 | 5,000 | 10,000 |
|---|---:|---:|---:|---:|---:|
| Transform (logs → OTel) | 925 µs ✓ | 1.35 ms ✓ | 4.27 ms ✓ | 22 ms ✓ | 44 ms ✓ |
| Tree build | 29 µs ✓ | 118 µs ✓ | 232 µs ✓ | 1.60 ms ✓ | 2.88 ms ✓ |
| HTML generate | 239 µs ✓ | 733 µs ✓ | 2.15 ms ✓ | 12 ms ✓ | 29 ms ✓ |
| DOM render (JS) | 7.80 ms ✓ | 35 ms ✓ | 78 ms ✓ | 452 ms ✓ | 775 ms ✓ |
| DOM render (+ paint) | 18 ms | 50 ms | 91 ms | 209 ms | 448 ms |
| Zoom (wheel) | 34 ms ✓ | 46 ms ✓ | 120 ms ✗ | 479 ms ✗ | 1524 ms ✗ |
| Pan (drag) | 33 ms ✓ | 33 ms ✓ | 50 ms ✓ | 261 ms ✗ | 1167 ms ✗ |
| Total pipeline | 19 ms ✓ | 52 ms ✓ | 98 ms ✓ | 244 ms ✓ | 523 ms ✓ |

## Environment

| | |
|---|---|
| Machine | Windows 11 Enterprise 10.0.26200, 20 logical CPUs, 32 GB, Intel Iris Xe (ANGLE / Direct3D 11); a managed laptop with endpoint-security agents running |
| Browser | the Chromium 152.0.7977.167 inside Claude desktop 4.4212.0 (the built-in browser pane, in a pop-out window of its own) |
| Window | viewport 537×550 CSS px (outer 915×708) at devicePixelRatio 1.5 on a 2560×1440 display; the stage is 521 px wide; 60 Hz (idle rAF interval median 16.66 ms, p95 ≈ 17 ms) |
| Isolation | `crossOriginIsolated` true (COOP/COEP from `demo/server.js`), so timers are fine-grained; `performance.measureUserAgentSpecificMemory()` exists but throws "not available" in this build |
| Observers | `longtask`, `long-animation-frame` and Event Timing all supported |
| Noise floor | a 2M-iteration loop took 3.8–4.6 ms at the start of most runs and 6–8 ms at the start of others; after heavy runs it read 7–10 ms. The frame probe (a 40 px square moved once per frame on an empty page) read p95 16.8–17.1 ms in every run |

## What the baseline shows

- **Everything is in the DOM.** Elements = 8 per span + 1 per event + 47 fixed (the formula matches the measured
  count exactly at 1K, 5K, 10K, 20K and 50K): 12K elements at 1K spans, 56K at 5K, 111K at 10K, 227K at 20K, 552K at
  50K. The "virtual scroll" window is the whole list at every size (`virtualScrollWindow` is `0…N` with
  `rendered = N` in every first-render result), so the page is N × 35 px tall (35K px at 1K, 1.75M px at 50K) and
  scrolling is not virtualized either.
- **Zoom is the cliff.** Frame interval of a wheel-zoom step, p50: 250 ms at 1K, 1.3 s at 5K, 3.4 s at 10K. At 20K
  the first step blocked the page for more than 60 s and later steps took ≈10 s each; at 50K the first step had not
  produced a frame after 3 minutes (both are `DNF` above). Each wheel event rewrites an inline `transform` on every
  duration label and every event marker (O(spans + events) style writes, plus a forced layout), and most of the cost
  is rendering, not script: in a 5K zoom scenario (61 s) long animation frames add up to 33–35 s, 19–20 s of which is
  style and layout, while the main thread was in long tasks for 60 s of the 61.
- **After any zoom or reset everything else gets slower.** The first zoom or "Reset" (even back to 100%) leaves an
  inline `transform` on every label and marker, and from then on every frame is slower. Select, p50: 27 → 73 ms at
  1K, 71 ms → 1.0 s at 5K, 204 ms → 3.6 s at 10K (`select` against `select-after-zoom`); hover: 17 → 33 ms, 33 →
  75 ms, 67 → 117 ms. A first version of the harness reset the zoom before every scenario and so measured the slow
  state everywhere (at 5K the same click took ≈50 ms on a fresh page and ≈700 ms after one Reset); that is why zoom
  and pan run last and the repeat scenarios exist. An implementation without such state should show the same numbers
  in both places.
- **The 2000-event span is expensive to select.** 0.7 s at 1K, 0.85–1.25 s at 5K, 2.5 s at 10K, 1.0–1.1 s at 20K and 50K
  (the span differs per size, so there is no clean trend); 3–5 s after zoom. The detail panel gets 50,045–50,051
  DOM nodes for it (25 per event) against ~70 for a typical span.
- **Collapse, expand and filter rebuild the whole view.** Collapse/expand of one subtree, p50: 136/197 ms at 1K,
  538/994 ms at 5K, 1.3/2.0 s at 10K, 2.3/4.5 s at 20K, 9.0/11.0 s at 50K. Clearing a filter: 90 ms, 0.9 s, 2.2 s,
  4.0 s, 25 s. `collapseAll` is cheap (it leaves one row); `expandAll` costs a full render (0.1 s at 1K, 0.6 s at 5K).
  Past 10K the 60 s budget ends the collapse scenario after 35, 18 and 7 operations.
- **Scrolling is smooth only while the page is small.** Smooth scroll frame p50: 17 ms at 1K, 33 ms at 5K, 83 ms at
  10K, 167 ms at 20K, 434 ms at 50K (the page scroll itself runs no script; the cost is painting and compositing a
  huge document); random jumps are worse (57 ms at 5K, 567 ms at 50K). Hover is 17 ms per frame at 1K and 367 ms at 50K.
- **Chevron clicks are dead after the initial render of more than 200 spans.** Virtual scrolling replaces the labels
  whose chevrons had listeners with windowed ones that have none, so a click does nothing until some re-render keeps
  the same window. In every chevron operation of every run (`adapterNotes.chevronClicksEffective` is 0) the
  harness had to fall back to what the handler does, `viewModel.toggleCollapse(id)` + `_rerender()`. This is a
  functional defect of the current element, not only a performance number.
- **Zoom is capped at 10×** (`Math.min(10, …)`), so the plan's "drag-pan at 20×" cannot be reproduced on the old
  element; the harness zooms towards 20×, records the zoom it reached (`zoomAchieved`: 10 at 1K, 5K and 10K) and pans
  there. On bigger traces the zoom-in setup is cut by its budget and pan never ran.
- **First render** (synchronous JS / to the first frame): 90 / 141 ms at 1K, 493 / 846 ms at 5K, 1.25 / 2.06 s at 10K,
  2.4 / 3.8 s at 20K, 7.6 / 11.7 s at 50K. The library's own `log2trace:render` measure is a small part of it (78 ms of
  ≈450 ms at 5K): the rest is listener attachment, forced layout and the second pass of `renderVirtualWindow`, which
  rebuilds the same rows.
- **Memory.** The page sees only its JS heap: TraceData is 7 MB at 1K and 144 MB at 50K, and the first render adds 3 MB
  (1K) to 91 MB (50K); the DOM (552K elements at 50K) lives in native memory that `performance.memory` does not show, and
  `measureUserAgentSpecificMemory()` is unavailable in this browser. Sampling the renderer process from Windows by
  hand every 15 s: 2.7–3.5 GB around the first render of 50K, 7.0–7.4 GB while collapse and filter rebuilt it, and
  ≈5 GB after minutes of zooming at 20K.

### Against the plan's budgets (medians; pristine state unless noted)

| Budget (plan, 50K spans / 100K events unless noted) | 5K spans | 10K spans | 50K spans |
|---|---:|---:|---:|
| Table + first frame ≤ 400 ms (≤ 100 ms at 5K) | 493 ms JS, 846 ms to first frame | 1.25 s JS, 2.06 s to first frame | 7.6 s JS, 11.7 s to first frame |
| Frames during gestures: p95 ≤ 18 ms, ≤ 2% over 20 ms | zoom p95 1.6 s, pan p95 157 ms, 100% of zoom frames over 20 ms | zoom p95 14 s, pan p95 283 ms | zoom did not finish |
| Hover → overlay ≤ 1 frame | 33 ms p50 per frame; 75 ms after zoom | 67 ms; 117 ms after zoom | 367 ms |
| Select → panel ≤ 50 ms (≤ 150 ms for 2000 events) | 71 ms p50, 125 ms p95; 1.05 s for 2000 events | 204 ms p50; 2.5 s for 2000 events | 657 ms p50; 1.07 s for 2000 events |
| Collapse → next frame ≤ 50 ms | 538 ms | 1.29 s | 9.0 s |
| Nodes in the shadow DOM ≤ 1,500 | 56,223 elements | 111,218 elements | 552,331 elements |
| View-layer heap ≤ 30 MB | not measurable here (DOM is native memory) | not measurable here | not measurable here (renderer 2.7–7.4 GB) |

### Flat dataset (the data of `benchmark.html`, 5,000 spans in 500 traces, no hierarchy)

`#impl=current&n=5000&flat=1`: 50,047 elements; first render 544 ms JS / 841 ms to first frame; hover 33 ms; select
60 ms (853 ms after zoom); resize 133 ms; scroll 33 ms; wheel-zoom frame p50 783 ms (71 frames before the budget ended);
filter clear 841 ms; no collapse scenario (nothing to collapse). `benchmark.html` on the same data (10 000 logs) reports a
single wheel step of 1.5 s and a first render of 0.45–0.77 s, the same order of magnitude.

## Caveats

- **One machine, one window, one engine.** Chromium 152 only: no Firefox or WebKit, no CPU throttling. The window is
  537×550 CSS px at devicePixelRatio 1.5, not the plan's ≈1400×800 at 2. Frame costs depend on the window, the display
  and what else runs on the machine, and the CPU probe swings by 2× between runs (3.8–8 ms). Compare only runs taken in the
  same window, look at `env.probe` and `probeEnd` of each run, and repeat before trusting differences under ~30%. A
  run of the new renderers should be compared with a fresh `current` run from the same window, not only with these files.
- **Harness version.** The runs were taken with `demo/perf.html` sha256 `a7e8e8c0…ab8e`; the committed file differs from it only in a corrected comment (the `hud` flag note). An earlier iteration of the harness (zoom first, zoom reset before every scenario) produced numbers 3–15× worse for hover, select, resize and scroll at 1K–5K, because it measured the post-zoom state everywhere; those runs were discarded.
- **Few repeats.** 1K was run 3 times, 5K twice, the larger sizes once (a 10K+ run takes 4–7 minutes and the 20K/50K
  renderer uses 3–7 GB). The spread table shows the run-to-run range where there are repeats.
- **Synthetic input.** Events are dispatched by script, one per frame. Event Timing does not report untrusted events,
  so `eventTiming` is empty in the scripted runs; handler time and action→next-frame latency stand in for it.
  `manual=1` (mount, then 15 s of hand-driven interaction) records Event Timing for real input; a manual run at 5K
  recorded 82 entries and an INP-like p95 of 136 ms for four clicks near the top of the list, but it was taken with an
  earlier iteration of the harness and is not part of the baseline.
- **The 60 s budget per scenario.** On big traces a frame takes seconds, so `timeout` cells rest on a few samples (the
  counts are in the JSON): 15 zoom frames at 10K, 7 collapse operations at 50K. Treat those medians as indicative.
- **Zoom ceiling.** The element stops at 10×, so pan is measured at 10× (or lower when the setup was cut).
- **Events.** The brief asked for about two events per span and 1% log-heavy spans of 500–2000 events. The two cannot
  both hold: 1% of 50K spans × ~1,080 events is ≈540K extra events, against the ≈100K the plan budgets for 50K spans.
  The default is `heavy=0.001` (50 log-heavy spans at 50K, 152,284 events in total, 3.0 per span); `heavy=0.01` gives
  the literal profile and was not run for this baseline. Fan-out classes are measured on internal nodes (about 80% of
  the spans are leaves): at 50K they are 70.3% / 24.9% / 4.8% for 1–3 / 4–12 / 20–60 children, plus four nodes with 500.
- **Memory** is JS heap only plus hand-sampled process memory, see above.
- **Frame thresholds.** At 60 Hz idle `requestAnimationFrame` deltas already reach 16.85 ms, so the literal "over
  16.7 ms" has a noise floor of a few percent; `over20` (the plan's budget) and `overRefresh1_5` are in the JSON too.
- **What `first-render` includes.** Synchronous JS up to the end of the `traceData` setter, which contains a forced
  layout (`recalculateTimelineTicks` reads `clientWidth`) and the second render pass of the virtual window.
- **Chevron fallback.** The collapse scenario uses the programmatic equivalent of the chevron handler because the
  chevrons are dead (see above); the cost measured is the full re-render, which is what a working click would cost.
- **`benchmark.html`** takes one sample per cell and renders into a 400 px high box with `overflow: hidden`, so it paints
  less than `perf.html` does.
- **The zoom did-not-finish records** (`*.zoom-dnf.json`) come from an earlier iteration of the harness in which
  `wheel-zoom` ran right after `first-render`; the zoom code path, the watchdog and the dataset are unchanged.
- **Not baselined:** `ns=0` (the element truncates to whole milliseconds anyway), `heavy=0.01`, `wd` other than 60.

## How to reproduce

```bash
git checkout 38df9e68d022a33f6512dcf6fdb3e054e8aecb4a    # the commit measured here (main, 1.0.0-RC2)
npm ci
npm run build:bundle                                     # dist/log2trace.min.js, the bundle perf.html loads
node demo/server.js                                      # http://localhost:3000, sets COOP/COEP
```

Open one page per run in a **visible** browser window (a hidden tab does not run `requestAnimationFrame`, so the
page refuses to start):

```
http://localhost:3000/perf.html#impl=current&n=10000&auto=1
```

`demo/server.js` looks files up by the raw request URL, so `perf.html?n=10000` is a 404 there. `perf.html`
therefore reads its flags from the `#fragment` as well as from `?query` (use `?` with any server that strips the
query string). The flags are documented at the top of `demo/perf.html` and `demo/perf-gen.js`: `n`, `seed`, `ns=0`,
`flat=1`, `heavy`, `ev`, `impl`, `auto=1`, `only=`, `wd=`, `sink=`, `probe=1`, `manual=1`, `hud=1`, `rev=`, `label=`.

Each page load produces one JSON: a `PERF_RESULT …` line in the console, **Download JSON** / **Copy JSON** in the
overlay, and `window.__PERF_RESULT`. `sink=<url>` additionally POSTs progress beacons and the result to a collector
(`tools/collect.mjs`), which is how the files in this folder were captured; `tools/aggregate.mjs` turns the run files into the tables and `summary.json`. The
overlay is hidden while a run measures (`hud=1` keeps it) so that nothing but the page under test is on screen.

These runs were served by a copy of `demo/server.js` that differs only in `PORT` and `__dirname`, because `:3000`
belongs to the main checkout; `demo/server.js` itself is untouched.

`probe=1` measures only the environment (a CPU loop and the frame pipeline on an empty page), the quickest way to
check that two windows are comparable. Every run records the same probes before and after.

## Protocol

One page load per run. The dataset is `generateTrace({ n, seed: 1 })` (`demo/perf-gen.js`), mounted once with
`<trace-visualizer full-width show-legend>`; the scenarios then run in this fixed order on the same mounted view:

| # | Scenario | What it does |
|---|---|---|
| 1 | `first-render` | `el.traceData = data` (sync JS: index, markup, listeners), then to the first frame (rAF + message task) and to the second rAF (the double-rAF of `benchmark.html`) |
| 2 | `hover` | 300 frames, one `mouseenter` + `mousemove` on a random visible bar per frame |
| 3 | `select` | 50 rows (49 random + the span with 2000 events): scroll to the row, click the bar, time until the next frame |
| 4 | `resize` | 40 frames alternating the stage width between 100% and 70% |
| 5 | `collapse` | collapse/expand a subtree ×20, then `collapseAll`/`expandAll` ×3; the subtree has ≈10K descendants, or 40% of the spans on smaller traces |
| 6 | `filter` | local text filter on the span name: selective (the token closest to 2% of spans), broad (closest to 50%; 13–17% at these sizes), clear; 3 rounds when fast |
| 7 | `scroll` | page scroll: 200 smooth frames (2 rows per frame), then 50 random jumps |
| 8 | `wheel-zoom` | 120 frames, one synthetic `wheel` per frame (12 in, 12 out, …), anchor sweeping left to right |
| 9 | `drag-pan` | zoom towards 20× (the element caps at 10×; the zoom reached is recorded), `mousedown` + 120 `mousemove` (600 px out, 600 px back) |
| 10 | `hover-after-zoom`, `select-after-zoom` | scenarios 2 and 3 again (150 frames, 12 rows) after zoom and pan |

The order is deliberate. The current element writes an inline `transform` on every duration label and event marker
the first time anything zooms or resets (even back to 100%), and from then on every frame is much slower. Scenarios
that are not about zoom therefore run first, on the pristine DOM; zoom and pan come last; hover and select are
repeated afterwards so the after-zoom state is measured instead of hidden. An implementation without such state
shows the same numbers in both places.

Metrics per scenario: rAF-interval statistics (p50/p95/p99/max, % of frames over 16.7 / 20 / 33.3 ms and over 1.5
refresh intervals), synchronous handler time of every synthetic input, action→next-frame latency for discrete
actions, `longtask` and `long-animation-frame` summaries (script, render, style+layout and forced style+layout
time, the three worst frames with their scripts), Event Timing entries, the DOM element count after the scenario
(TreeWalker, shadow roots included), JS heap checkpoints, and environment probes before and after the run.

Each scenario has a 60 s budget (`wd`, counted from the end of its setup): when frames are slow the loop stops
early and the result is marked `timeout` with the number of frames/operations actually done. A worker watches the
page's heartbeat; 60 s of silence is reported as `hang` to the sink. A run that crashes or hangs is recorded as
*did not finish*.

## Files

- `current-n<N>.run<k>.json`: one file per run, the complete result of one page load (environment, dataset statistics, probes, every scenario with its frame, handler, long-task and LoAF data). 1K ×3, 5K ×2, 10K, 20K and 50K ×1 (20K and 50K without zoom, pan and the after-zoom repeats).
- `current-n20000.zoom-dnf.json`, `current-n50000.zoom-dnf.json`: the zoom runs that did not finish, rebuilt from the page's beacons (what ran, the watchdog report, the environment and dataset).
- `current-n5000-flat.run1.json`: the flat dataset of `benchmark.html` through the same harness.
- `benchmark-html-10k-flat.json`: the one `demo/benchmark.html` run, parsed from its table and log.
- `summary.json`: median / min / max / per-run values of every metric per size, with the provenance (commit, bundle, harness hashes, environment).
- `tools/collect.mjs`: the sink that receives `sink=` beacons and results; `tools/aggregate.mjs`: builds the tables and `summary.json` from the run files.
