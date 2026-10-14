# References

## Process & Output

| File | Purpose |
|------|---------|
| [severity.md](severity.md) | Severity level definitions and decision framework |
| [process.md](process.md) | Step-by-step review process, exit criteria |
| [output-format.md](output-format.md) | Review output template and worked examples |

## Check Categories (`checks/`)

Load only what's relevant to the code under review:

| Category | File | Use When |
|----------|------|----------|
| **Auth & Authorization** | [checks/auth.md](checks/auth.md) | Login, JWT, sessions, role/permission checks |
| **API Endpoints** | [checks/api.md](checks/api.md) | HTTP routes, request handling, BOLA/BFLA |
| **Database** | [checks/database.md](checks/database.md) | SQL queries, ORM, migrations |
| **Async & Concurrency** | [checks/async.md](checks/async.md) | Promises, async/await, race conditions |
| **Correctness & Logic** | [checks/correctness.md](checks/correctness.md) | Bugs, edge cases, null handling |
| **Security** | [checks/security.md](checks/security.md) | Injection, SSRF, crypto, logging, LLM |
| **Performance** | [checks/performance.md](checks/performance.md) | N+1, memory, caching |
| **UI & Components** | [checks/ui.md](checks/ui.md) | React/Vue components, state, XSS |
| **Supply Chain** | [checks/supply-chain.md](checks/supply-chain.md) | New/updated dependencies, lockfiles |

## Quick Selection

**Backend/API:** auth + api + database + async (+ security if sensitive)

**Frontend:** ui + correctness + security (XSS focus)

**PR adds new deps:** supply-chain

**Full-stack PR:** start with SKILL.md table, load based on changed file types
