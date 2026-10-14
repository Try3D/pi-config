---
name: stage
description: "Inspect and stage local code changes. Use this skill whenever the user wants to review their unstaged or untracked files before committing. Eg. 'stage my changes', 'check my code and add it', 'review and stage', 'is this ready to commit?', 'look over what I changed'. It only operates on local changes — not PRs or remote branches."
argument-hint: "[file path, or leave blank to review all pending changes]"
metadata:
  author: Saran
---

# /stage

Inspect local code changes, clean up minor noise, and stage files that pass. Your job: read every unstaged and untracked file, check it for issues, do light cleanup, then either `git add` it or flag it for the user. You never touch remote branches, PRs, or committed code.

## What It Does

```
┌───────────────────────────────────────────────────────────────┐
│                      CODE STAGE                               │
├───────────────────────────────────────────────────────────────┤
│  ✓ Reads all unstaged + untracked local changes               │
│  ✓ Security audit (OWASP top 10, injection, auth)             │
│  ✓ Performance review (N+1, memory leaks, complexity)         │
│  ✓ Correctness (edge cases, error handling, race conditions)  │
│  ✓ Style (naming, structure, readability)                     │
│  ✓ Cleans up useless comments and dev debug prints            │
│  ✓ git add files that pass — flags files that don't           │
└───────────────────────────────────────────────────────────────┘
```

## Core Principles

1. **You are a reviewer that stages, not an editor that rewrites.** The only code modifications you may make are removing obviously useless comments and dev debug logging (defined below). Never change logic, fix bugs, refactor, or rewrite anything.

2. **Only review what changed.** Focus on the changed lines and their immediate surrounding context. Code that existed before and wasn't touched should be assumed to work as intended — don't flag issues in unchanged code or try to remove comments / logs from them.

3. **Per-file decision.** For each changed/new file:
   - **Pass** → `git add <path/to/file>`
   - **Concern** → do NOT stage, explain the concern clearly

4. **Be precise, not noisy.** Only flag real issues. A potential SQL injection matters. A style nitpick in untouched code doesn't. Not everything is critical — calibrate severity honestly.

---

## Step 1: Gather Changes

Run `git status` to see all pending changes (unstaged, staged, and untracked). Then:
- `git diff` for unstaged changes to tracked files
- `git diff --cached` for already-staged changes
- Read each untracked file fully (they're entirely new)

If the user provided a file path as an argument (e.g., `/stage src/app.py`), review **only that file** — skip everything else. Use `git diff <file>` for tracked files or read the file directly if untracked.

## Step 2: Review Each File

For every changed file, assess the changes across these dimensions:

### Security
- SQL injection, XSS, CSRF
- Authentication and authorization flaws
- Secrets or credentials in code
- Insecure deserialization
- Path traversal
- SSRF

### Performance
- N+1 queries
- Unnecessary memory allocations
- Algorithmic complexity (O(n²) in hot paths)
- Missing database indexes
- Unbounded queries or loops
- Resource leaks

### Correctness
- Edge cases (empty input, null, overflow)
- Race conditions and concurrency issues
- Error handling and propagation
- Off-by-one errors
- Type safety

### Maintainability
- Naming clarity
- Single responsibility
- Duplication
- Test coverage
- Documentation for non-obvious logic

## Step 3: Clean Up

Perform these two cleanup passes on **user-written changed/new code only**. Do them silently.

**Critical: Never clean up generated files.** Lock files (`uv.lock`, `package-lock.json`, `yarn.lock`), auto-generated configs, migration files, compiled output, bundled vendor code, and anything clearly machine-generated — leave exactly as-is. Do not remove comments or logging from these files.

### Remove obviously useless comments

Only remove comments that are truly pointless — where the comment and the code say the exact same thing. Don't be conservative as most comments fall under this category.

**Keep these:**
- Alert/warning comments: `// DO NOT ...`, `// WARNING:`, `// HACK:`, `// FIXME:`, `// NOTE:`
- Comments explaining **why** something is done a certain way
- Comments documenting algorithms, math, business rules, or domain logic
- TODOs (with or without tickets)
- Section headers and organizational comments

### Remove excessive logging

Only remove logging that is clearly dev noise.

**Remove only these:**
- `print(f"value of x: {x}")` or `console.log(x)` — debug prints left from development
- Logging the exact same information multiple times in sequence
- `log.debug("entering function X")` / `log.debug("exiting function X")` at every function boundary

**Keep ALL of these — do not remove:**
- Error and exception logging
- Warning logs
- Info logs at system boundaries (startup, shutdown, request handling, external calls)
- Audit logs
- Logs with useful context (request IDs, user IDs, timing)
- Any logging in generated/config files

## Step 4: Stage or Flag

For each file:
- If it passes review → `git add <path/to/file>`
- If it has concerns → do NOT stage, note the concern for the summary

## Step 5: Output Summary

```markdown
## Code Stage: [brief description of the changes]

### Summary
[1-2 sentence overview of the changes and overall quality]

### Critical Issues
| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | path/to/file | 42 | Description of the problem | 🔴 Critical |
| 2 | path/to/file | 87 | Description of the problem | 🟠 Warning |

(If no critical issues, write "No critical issues found.")

### Suggestions
| # | File | Line | Suggestion | Category |
|---|------|------|------------|----------|
| 1 | path/to/file | 15 | Consider using parameterized query | Security |
| 2 | path/to/file | 33 | This loop could be O(n^2) with large input | Performance |

(If no suggestions, write "No suggestions.")

### Files Staged
- `path/to/clean/file.py` ✓
- `path/to/another/clean/file.py` ✓

### Files NOT Staged (need attention)
- `path/to/concerning/file.py` — [brief reason]
```

---

## Important Reminders

- **DO NOT modify code logic.** The only edits allowed are removing obviously useless comments and dev debug logging. Never fix bugs, refactor, or change behavior.
- **DO NOT create commits.** You only stage files. The user decides when to commit.
- **DO NOT review unchanged code.** If a line wasn't part of the diff, it's out of scope. Exception: if a new change introduces a clear interaction bug with adjacent code (e.g., calling a function with wrong argument count).
- **DO NOT remove comments or logs from unchanged code.** Cleanup applies only to changed/new files.
- **Be honest about uncertainty.** "This might be intentional, but worth double-checking: ..." is better than a false alarm or a missed bug.
