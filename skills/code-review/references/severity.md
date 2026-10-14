# Severity Levels

## Quick Reference

| Level | Emoji | Action | Examples |
|-------|-------|--------|----------|
| **Critical** | 🔴 | Must fix before merge | Security vulns, auth bypasses, crash bugs, data loss |
| **High** | 🟠 | Should fix before merge | Major functionality broken, race conditions |
| **Medium** | 🟡 | Fix before merge | Code smell, edge cases not handled |
| **Low** | 🔧 | Optional | Style improvements, cosmetic issues |
| **Note** | 📝 | Observation | Good patterns, questions, suggestions |

## Decision Framework

When uncertain, ask in order:

1. **Security issue?** → 🔴 Critical
2. **Causes crash or data loss?** → 🔴 Critical
3. **Breaks major functionality?** → 🟠 High
4. **Could cause bugs in some cases?** → 🟡 Medium
5. **Easy fix / style / cleanup?** → 🔧 Low
6. **Just an observation?** → 📝 Note

## Definitions

### 🔴 Critical

Issues that could lead to: security breach, system crash, data corruption, auth bypass, user data loss, legal/compliance violations.

Examples: SQL injection, IDOR, missing auth on sensitive endpoint, hardcoded credentials, unhandled promise rejection causing crash, race condition corrupting data.

### 🟠 High

Issues that significantly impact functionality: major features broken, severe performance degradation, missing or incorrect error handling, critical unhandled edge cases.

Examples: payment bypass via crafted input, incorrect report calculations, silent file upload failures, indefinite stale cache.

### 🟡 Medium

Quality issues worth fixing: harder to maintain, potential bugs in unlikely scenarios, inconsistent error handling, missing edge case validation.

Examples: empty array not handled (but data usually exists), type coercion bugs in unlikely paths, magic numbers, missing public API docs, unused imports.

### 🔧 Low

Optional improvements: style inconsistencies, minor performance wins, cosmetic cleanup.

Examples: unclear variable name, unhelpful comment, slight optimization possible, extractable duplication.

### 📝 Note

Observations worth mentioning: good patterns, questions about intent, future improvement suggestions, positive feedback.

Examples: "Nice error handling here ✅", "Is this intentionally public? ❓", "Consider tests for this edge case 💡"
