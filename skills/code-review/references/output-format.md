# Review Output Format

## Template

```markdown
## Code Review Summary

**PR/Commit:** [reference]
**Files Reviewed:** [N files]
**Base:** [commit/branch this is compared against]
**Date:** YYYY-MM-DD

---

### 🔴 Critical Issues (Must Fix Before Merge)

1. **[file:line]** Description
   - **Impact:** [Security risk, bug, regression]
   - **Attack Scenario:** [How it could be exploited]
   - **Fix:** [Specific code change needed]

### 🟠 High Priority Issues

1. **[file:line]** Description
   - **Issue:** [What's wrong]
   - **Fix:** [How to fix]

### 🟡 Medium Priority

1. **[file:line]** Description
   - **Suggestion:** [Improvement]

### 🔧 Suggested Improvements

1. **[file:line]** [Easy improvement if approved]

### 📝 Notes and Observations

- [Good patterns you noticed]
- [Things that are correct by design]
- [Questions to consider]

---

### Summary and Recommendation

[Overall assessment — Approve / Request Changes / Needs Discussion]
```

## Example: Documentation Fix

```markdown
## Code Review Summary

**PR:** #546 - fix: spelling mistakes
**Files Reviewed:** 11 files
**Base:** 4939cfe
**Date:** 2026-04-17

---

### 🔴 Critical Issues

None. PR contains only spelling corrections.

### 🟠 High Priority Issues

None.

### 🟡 Medium Priority

1. **[docs/windmill/documentation.md:29]** Broken markdown link was fixed ✅

### 📝 Notes

- All changes are spelling/grammar corrections
- One broken link fixed
- No functional code changes

---

### Summary and Recommendation

✅ **Approve** - Clean, scoped documentation fix.
```

## Example: Security Issue

```markdown
## Code Review Summary

**PR:** #XXX - user dashboard endpoint
**Files Reviewed:** 3 files
**Base:** abc123

---

### 🔴 Critical Issues

1. **[api/users.ts:45]** IDOR — user can access any user's data
   - **Impact:** Any authenticated user can view other users' private data
   - **Attack Scenario:** Attacker modifies `userId` parameter to access victim's data
   - **Fix:** Filter query by authenticated user's ID, not client-provided ID

2. **[api/users.ts:78]** SQL injection via string concatenation
   - **Impact:** Database compromise through malicious input
   - **Fix:** Use parameterized query

### 🟠 High Priority

1. **[api/users.ts:90]** Missing rate limiting — endpoint can be spammed

---

### Summary and Recommendation

❌ **Request Changes** - Critical security issues must be fixed.
```
