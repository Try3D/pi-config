---
name: code-review
description: "Review code for bugs, security issues, and quality. Use when the user asks to review a PR, check a diff, audit a file, look at changes, or give feedback on code — including casual asks like 'can you look at this?', 'check my changes', 'what do you think of this PR?', or when given a GitHub PR URL or commit SHA."
argument-hint: "[GitHub PR URL | PR number | commit SHA | branch name | leave blank for current working tree]"
metadata:
  author: Saran
---

# Code Review Skill

Review code changes with deep analysis. Flag issues, think like an attacker, leave code better than you found.

Figure out what the user gave you (PR link, PR number, branch, commit SHA, local files, unstaged changes) and adapt accordingly. For the full process for each case: read `references/process.md`.

## Check Categories

Load only what's relevant to the code under review:

| Code Type | Load |
|-----------|------|
| Auth / user access / JWT | `references/checks/auth.md` |
| HTTP endpoints | `references/checks/api.md` |
| Database queries | `references/checks/database.md` |
| Async operations | `references/checks/async.md` |
| General bugs / logic | `references/checks/correctness.md` |
| Security issues | `references/checks/security.md` |
| Performance | `references/checks/performance.md` |
| UI components | `references/checks/ui.md` |
| New/updated dependencies | `references/checks/supply-chain.md` |

Full selection guide: `references/README.md`

## Severity Levels

Five levels: 🔴 Critical → 🟠 High → 🟡 Medium → 🔧 Low → 📝 Note.

For full definitions and decision framework: read `references/severity.md`.

Quick rule: security issue = 🔴, crash/data loss = 🔴, broken feature = 🟠, edge case bug = 🟡, style = 🔧.

## Output Format

For the review template and worked examples: read `references/output-format.md`.

Always include: file:line reference, why it's an issue, and a concrete fix suggestion.

## Key Principles

1. **Think like an attacker** — how could this be exploited?
2. **Trace data flows** — Input → Validation → Processing → Query → Output
3. **Be specific** — file:line + exact fix, not vague complaints
4. **Security first** — security issues take priority over style
5. **Ask before fixing** — flag improvements, wait for permission to apply them
