# A/B: canvas against dom, 2.0.0-rc.1 (2026-11-05)

Collected with `baseline/tools/ab-run.mjs`, tabulated with `baseline/tools/aggregate-ab.mjs`.
Headless Chrome 157 (pixel ratio and CPU throttling set through the launch flag and the DevTools protocol) and
headless Firefox 159 (pixel ratio from a profile preference, no throttling), viewport 1400 x 800, Intel HD
Graphics through ANGLE, 20 logical cores, 60 Hz. Each cell is the median of 2 repeats; a single repeat is
quantised to 16.7 ms steps (17/33/50), so a difference of one step is noise. WebKit is not measured (not
available on this machine). Firefox headless has a noisy floor of its own (the idle pipeline probe shows p95
around 90 ms), so its absolute numbers are over budget for both painters.

### chrome, dpr1, 5,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 94.2 | 131 | 0.72 | canvas slower by 40 % |
| wheel-zoom frame p95, ms | 16.9 | 16.8 | 1.01 |  |
| drag-pan frame p95, ms | 16.9 | 16.8 | 1.01 |  |
| scroll frame p95, ms | 17.0 | 16.8 | 1.01 |  |
| hover frame p95, ms | 17.3 | 17.1 | 1.01 |  |
| select to frame p95, ms | 29.9 | 27.6 | 1.08 |  |
| collapse all to frame, ms | 19.3 | 18.2 | 1.06 |  |
| long tasks, count | 2.0 | 2.0 | 1.00 |  |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 8.9 | 9.3 | 0.96 |  |

### chrome, dpr1, 50,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 257 | 349 | 0.73 | canvas slower by 36 % |
| wheel-zoom frame p95, ms | 16.9 | 16.8 | 1.01 |  |
| drag-pan frame p95, ms | 16.8 | 16.8 | 1.00 |  |
| scroll frame p95, ms | 16.9 | 16.9 | 1.00 |  |
| hover frame p95, ms | 17.3 | 17.1 | 1.01 |  |
| select to frame p95, ms | 25.7 | 23.8 | 1.08 |  |
| collapse all to frame, ms | 17.0 | 17.4 | 0.98 |  |
| long tasks, count | 2.0 | 0.5 | 4.00 | dom slower by 300 % |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 15.8 | 8.3 | 1.90 |  |

### chrome, dpr2-cpu4, 5,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 633 | 430 | 1.47 | dom slower by 47 % |
| wheel-zoom frame p95, ms | 83.2 | 16.8 | 4.96 | dom over budget; dom slower by 396 % |
| drag-pan frame p95, ms | 33.4 | 17.1 | 1.95 | dom over budget; dom slower by 95 % |
| scroll frame p95, ms | 91.5 | 50.0 | 1.83 | dom over budget, canvas over budget; dom slower by 83 % |
| hover frame p95, ms | 41.8 | 50.0 | 0.84 | dom over budget, canvas over budget |
| select to frame p95, ms | 91.9 | 92.0 | 1.00 | dom over budget, canvas over budget |
| collapse all to frame, ms | 19.5 | 20.8 | 0.94 |  |
| long tasks, count | 108 | 41.0 | 2.62 | dom slower by 162 % |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 38.6 | 50.7 | 0.76 |  |

### chrome, dpr2-cpu4, 50,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 1862 | 1469 | 1.27 |  |
| wheel-zoom frame p95, ms | 16.8 | 16.8 | 1.00 |  |
| drag-pan frame p95, ms | 25.1 | 16.9 | 1.49 | dom over budget; dom slower by 49 % |
| scroll frame p95, ms | 33.3 | 16.8 | 1.98 | dom over budget; dom slower by 98 % |
| hover frame p95, ms | 41.6 | 16.9 | 2.47 | dom over budget; dom slower by 147 % |
| select to frame p95, ms | 103 | 62.3 | 1.66 | dom over budget, canvas over budget; dom slower by 66 % |
| collapse all to frame, ms | 24.1 | 21.6 | 1.12 |  |
| long tasks, count | 44.5 | 22.5 | 1.98 | dom slower by 98 % |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 45.7 | 60.0 | 0.76 |  |

### chrome, dpr2, 5,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 93.2 | 151 | 0.62 | canvas slower by 62 % |
| wheel-zoom frame p95, ms | 16.9 | 16.8 | 1.00 |  |
| drag-pan frame p95, ms | 16.8 | 16.9 | 0.99 |  |
| scroll frame p95, ms | 16.8 | 16.8 | 1.00 |  |
| hover frame p95, ms | 16.9 | 17.2 | 0.98 |  |
| select to frame p95, ms | 24.7 | 22.4 | 1.11 |  |
| collapse all to frame, ms | 17.9 | 17.5 | 1.02 |  |
| long tasks, count | 0.5 | 1.0 | 0.50 | canvas slower by 100 % |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 8.7 | 8.6 | 1.02 |  |

### chrome, dpr2, 50,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 278 | 346 | 0.80 |  |
| wheel-zoom frame p95, ms | 16.9 | 33.2 | 0.51 | canvas over budget; canvas slower by 97 % |
| drag-pan frame p95, ms | 16.8 | 16.9 | 0.99 |  |
| scroll frame p95, ms | 16.9 | 16.9 | 1.00 |  |
| hover frame p95, ms | 16.9 | 17.1 | 0.99 |  |
| select to frame p95, ms | 28.9 | 20.8 | 1.39 |  |
| collapse all to frame, ms | 18.4 | 17.5 | 1.05 |  |
| long tasks, count | 2.0 | 1.5 | 1.33 | dom slower by 33 % |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 8.4 | 8.6 | 0.98 |  |

### firefox, dpr1, 5,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 287 | 350 | 0.82 |  |
| wheel-zoom frame p95, ms | 42.5 | 60.7 | 0.70 | dom over budget, canvas over budget; canvas slower by 43 % |
| drag-pan frame p95, ms | 58.8 | 25.3 | 2.33 | dom over budget, canvas over budget; dom slower by 133 % |
| scroll frame p95, ms | 37.9 | 59.1 | 0.64 | dom over budget, canvas over budget; canvas slower by 56 % |
| hover frame p95, ms | 38.6 | 54.9 | 0.70 | dom over budget, canvas over budget; canvas slower by 42 % |
| select to frame p95, ms | 32.3 | 98.4 | 0.33 | canvas over budget; canvas slower by 205 % |
| collapse all to frame, ms | 22.6 | 21.5 | 1.05 |  |
| long tasks, count | 0.0 | 0.0 | n/a |  |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 8.2 | 23.8 | 0.34 |  |

### firefox, dpr1, 50,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 660 | 770 | 0.86 |  |
| wheel-zoom frame p95, ms | 44.5 | 55.2 | 0.81 | dom over budget, canvas over budget |
| drag-pan frame p95, ms | 42.5 | 45.5 | 0.93 | dom over budget, canvas over budget |
| scroll frame p95, ms | 43.3 | 77.7 | 0.56 | dom over budget, canvas over budget; canvas slower by 80 % |
| hover frame p95, ms | 42.5 | 38.5 | 1.10 | dom over budget, canvas over budget |
| select to frame p95, ms | 71.4 | 118 | 0.60 | dom over budget, canvas over budget; canvas slower by 65 % |
| collapse all to frame, ms | 19.1 | 19.1 | 1.00 |  |
| long tasks, count | 0.0 | 0.0 | n/a |  |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 35.5 | 10.9 | 3.26 |  |

### firefox, dpr2, 5,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 390 | 274 | 1.42 | dom slower by 42 % |
| wheel-zoom frame p95, ms | 62.1 | 69.8 | 0.89 | dom over budget, canvas over budget |
| drag-pan frame p95, ms | 43.5 | 76.7 | 0.57 | dom over budget, canvas over budget; canvas slower by 76 % |
| scroll frame p95, ms | 57.9 | 102 | 0.57 | dom over budget, canvas over budget; canvas slower by 77 % |
| hover frame p95, ms | 51.5 | 59.3 | 0.87 | dom over budget, canvas over budget |
| select to frame p95, ms | 86.9 | 131 | 0.66 | dom over budget, canvas over budget; canvas slower by 51 % |
| collapse all to frame, ms | 36.3 | 23.5 | 1.55 |  |
| long tasks, count | 0.0 | 0.0 | n/a |  |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 30.6 | 8.2 | 3.76 |  |

### firefox, dpr2, 50,000 spans (repeats: dom 2, canvas 2)

| metric | dom | canvas | dom / canvas | verdict |
|---|---:|---:|---:|---|
| first render to frame, ms | 1047 | 1087 | 0.96 |  |
| wheel-zoom frame p95, ms | 78.9 | 70.3 | 1.12 | dom over budget, canvas over budget |
| drag-pan frame p95, ms | 52.6 | 61.2 | 0.86 | dom over budget, canvas over budget |
| scroll frame p95, ms | 103 | 108 | 0.95 | dom over budget, canvas over budget |
| hover frame p95, ms | 63.0 | 76.6 | 0.82 | dom over budget, canvas over budget |
| select to frame p95, ms | 85.6 | 82.0 | 1.04 | dom over budget, canvas over budget |
| collapse all to frame, ms | 24.8 | 90.7 | 0.27 | canvas over budget; canvas slower by 266 % |
| long tasks, count | 0.0 | 0.0 | n/a |  |
| DOM elements after first render | 570 | 80.0 | 7.13 | dom slower by 613 % |
| CPU probe at start, ms | 13.2 | 13.3 | 0.99 |  |

