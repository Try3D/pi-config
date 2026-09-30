# Repository guidelines

This repository contains TypeScript extensions for the [Pi coding agent](https://pi.dev).

## Layout

- One directory per extension under `extensions/<name>/`, with an `index.ts` entry point.
- Each extension has its own `package.json` (with a `pi.extensions` entry) and `README.md`.
- The root `package.json` lists every extension in its `pi.extensions` array.
- Pi core modules are `peerDependencies` (`"*"`) and must not be bundled.

## Tools

- Use `rg` and `fd` for repository navigation.
- Run `npm run audit:code` after changes (typecheck + eslint + knip).

## Preferences

- Keep changes small and consistent with existing extension patterns.
- Reuse existing helpers before introducing new abstractions.
- Add argument completions to extension commands where useful.
- Never add an AI co-author to commits.
