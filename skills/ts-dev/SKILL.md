---
name: ts-dev
description: TypeScript development guardrails — type safety, import hygiene, dependency handling, and test discipline. Use whenever editing, reviewing, or generating `.ts`/`.tsx` files, fixing type errors, adding/upgrading npm dependencies in a TS project. Trigger even when the user doesn't explicitly mention TypeScript — if the file extension or repo signals TS, consult this skill.
metadata:
  author: Saran
---

# Development Rules

Rules for working in TypeScript codebases. Each rule includes the reasoning so you can judge edge cases instead of applying it blindly.

## Type safety

- No `any` types unless absolutely necessary
    - If you genuinely need `any` (untyped third-party API, gradual migration), leave a one-line comment naming the reason — not "TODO fix later".
- Avoid `as` casts; narrow with `typeof`/`in`/discriminated unions instead.
- Check node_modules for external API type definitions instead of guessing
- Run `tsc --noEmit` after every operation that touches the type system.


## Imports

- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.

## Dependencies

- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead

## Changing existing code

- Do not preserve backward compatibility unless the user explicitly asks for it
