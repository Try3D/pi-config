# Supply Chain & Dependency Checks

Load this file when a PR adds or updates dependencies (package.json, requirements.txt, go.mod, etc.).

## Key Questions

- Is this package widely used and actively maintained?
- Does the version pin prevent silent auto-updates?
- Does the package have postinstall scripts?
- Are transitive dependencies audited?

## Checklist

### New Dependency Added
- [ ] Is the package from a reputable source? (author, download count, GitHub activity)
- [ ] Is it pinned to an exact version rather than a range (`^` or `~`)?
- [ ] Does `npm audit` / `pip audit` / `govulncheck` pass after adding it?
- [ ] Is the package necessary, or does the stdlib or an existing dep already cover this?

### Postinstall / Lifecycle Scripts
```json
// RISK: Executes arbitrary code on install
"scripts": { "postinstall": "node scripts/setup.js" }
```
- Flag any `postinstall`, `preinstall`, or `install` scripts in new packages
- Check what those scripts do before merging

### Version Pinning
```json
// RISKY: Auto-updates on minor/patch releases
"express": "^4.18.0"

// SAFER: Exact pin (rely on lockfile for updates)
"express": "4.18.2"
```
Minor releases can introduce malicious code in a compromised package.

### Lockfile Integrity
- Is the lockfile (`package-lock.json`, `yarn.lock`, `poetry.lock`) committed and up to date?
- Does the lockfile match the declared versions?
- If the lockfile changed unexpectedly, investigate why.

### License Compatibility
- Does the new dependency's license (GPL, AGPL) conflict with the project's license?
- Is it acceptable for the use case (commercial product vs. internal tool)?

## Notes

- `npm audit`, `pip audit`, `cargo audit`, `govulncheck` should run in CI — flag if they don't
- For high-security projects: consider requiring provenance attestations (`npm install --provenance`)
- Typosquatting: check the package name carefully — `lodahs` vs `lodash`
- Flag if a trusted package was recently transferred to a new owner (npm transfer = risk signal)
