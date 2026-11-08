<!--
Note: ALL sections are optional. Delete every section that does not apply or add distinct reviewer signal.

Core Principles:
1. Proportionality: If the PR description is longer than the diff itself, it is over-engineered. For small or straightforward changes, a 1-2 sentence summary is preferred over filling out template sections.
2. Code Fact-Checking: Fact-check all technical claims, contracts, configuration options, and behaviors directly against the implementation before drafting.
3. No Anti-Patterns:
   - NEVER paste end-user documentation, usage manuals, or interaction guides into ## Reproduction.
   - NEVER dump lists or manifests of test file paths (e.g. `test/foo.test.ts: ...`) under ## Testing.
   - NEVER write filler claims like "Zero impact", "Zero impact on existing views", or "Zero overhead" under ## Performance Impact.
   - NEVER mirror ## What bullet-for-bullet with file paths under ## How.
   - NEVER include manual logs of automated checks (npm test, npm run check, npm run lint, etc.).
-->

## What
<!--
Concise summary of what changed.
- Open with an imperative statement (e.g. "Add sequence diagram view", not "Adds" or "Added").
- Keep high-level: summarize architectural, behavioral, and API changes, not granular usage guides.
-->


## Why
<!--
The problem solved, motivation, and context:
- What was broken, slow, or missing?
- Why this change is needed now.
- Any known tradeoffs or limitations.
-->


## Reproduction
<!--
Delete if not applicable or if Why makes the trigger clear.
- 1-3 concise human-facing steps to launch the demo or trigger the bug.
- DO NOT dump end-user documentation, usage manuals, or interaction guides here.
-->


## How
<!--
Delete if implementation is self-evident from the code diff.
- Non-obvious architectural, algorithmic, or data structure decisions only.
- Departures from existing patterns and why.
- DO NOT repeat What bullet-for-bullet with file paths.
-->


## Alternatives Considered
<!--
Delete unless genuine architectural tradeoffs were evaluated.
- Concrete alternative approaches considered and why they were rejected.
- NEVER invent hypothetical or strawman alternatives to fill the section.
-->


## Performance Impact
<!--
Delete if rendering FPS, memory footprint, or trace scale are unaffected.
- Concrete measurements, benchmarks, or memory figures (e.g. 50k+ spans).
- NEVER write filler claims like "Zero impact" or "Zero overhead". If unaffected, delete this section completely.
-->


## Testing
<!--
Delete if standard unit tests were added or if no tests were added.
- Describe new testing strategies, scale benchmarks, or edge-case coverage in 1-3 sentences.
- DO NOT dump lists or manifests of test file paths (e.g. `test/foo.test.ts: ...`).
-->

