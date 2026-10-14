# Detailed Review Process

## For PRs and Commits

### Step 1: Fetch and Verify

```bash
# Fetch a GitHub PR
git fetch origin pull/{PR_NUM}/head:pr-review && git checkout pr-review

# For a specific commit
git checkout {commit_sha}

# Find the base
git log --oneline -1 HEAD~1
```

### Step 2: Understand Changes

```bash
# All changed files
git diff {base}...HEAD --stat

# Full diff
git diff {base}...HEAD -- {files}

# New files only
git diff {base}...HEAD --name-only --diff-filter=A
```

### Step 3: Analyze Per File

**New files** — What is the purpose? What are inputs/outputs? Security implications? Obvious bugs?

**Modified files** — What exactly changed? Does it do what it claims? Any regressions? Downstream impact?

**Deleted files** — Is anything depending on this? Should this be a breaking change?

### Step 4: Load Relevant Checks

```bash
# APIs with auth
read references/checks/auth.md
read references/checks/api.md

# Database code
read references/checks/database.md

# Async operations
read references/checks/async.md

# New/updated dependencies
read references/checks/supply-chain.md
```

See SKILL.md or `references/README.md` for the full check-to-file mapping.

### Step 5: Security Deep Dive

Always check for:
- IDOR (can user A access user B's data?)
- Authentication bypasses
- Authorization gaps
- Injection vulnerabilities (SQL, XSS, command)
- Sensitive data exposure

### Step 6: Trace Data Flows

```
Input → Validation → Processing → Query → Output
   ↑______________|    |__________|    ↑_________|
   (auth here)      (logic)      (db)  (sanitize output)
```

### Step 7: Think Like an Attacker

- How could this be exploited?
- What if the input is malicious?
- What if the user is authenticated but adversarial?
- What if the database is slow or returns unexpected data?

## For Unstaged / Local Changes

```bash
git status
git diff           # unstaged
git diff --staged  # staged
```

Same analysis process, scoped to working directory.

## Exit Criteria

A review is thorough when you've:
- [ ] Seen all changed files
- [ ] Understood the purpose of each change
- [ ] Loaded and applied relevant check categories
- [ ] Traced data flows
- [ ] Considered attack scenarios
- [ ] Identified improvement opportunities (even if minor)
