# Contributing to log2trace-ui

## Git Commit Guidelines

Commit messages in this repository must follow **Chris Beams' style** ([How to Write a Git Commit Message](https://cbea.ms/git-commit/)).

> **Note**: Do **not** use Conventional Commits prefixes (e.g. `feat:`, `fix:`, `chore:`). Write plain, descriptive imperative statements instead.

### The Seven Rules

1. **Separate subject from body with a blank line**
2. **Limit the subject line to 50 characters** (hard limit: 72 characters)
3. **Capitalize the subject line**
4. **Do not end the subject line with a period**
5. **Use the imperative mood in the subject line** (e.g., `Add feature`, not `Added feature` or `Adds feature`)
6. **Wrap the body at 72 characters**
7. **Use the body to explain what and why vs. how**

### Example

```gitcommit
Add Service Graph view and 2D camera navigation

Provide engineers with an immediate top-level mental model of system
architecture, request flow, and latency bottlenecks for OpenTelemetry
traces by introducing an interactive Service Graph view.

- Implement a zero-dependency 5-stage Sugiyama DAG layout.
- Infer leaf peer dependencies (databases, messaging brokers).
- Compute exact interval-union self-times without underflow.
- Implement a pure math 2D affine camera for pan/zoom navigation.
```

### Automated Enforcement

The repository includes an automated Husky `commit-msg` hook backed by `build/check-commit-msg.js` that verifies all seven rules on every commit.
