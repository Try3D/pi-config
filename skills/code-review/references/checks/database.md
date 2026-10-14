# Database & Data Access Checks

Load this file when reviewing database queries, ORM operations, migrations, or data access patterns.

## Key Questions

- Are queries using parameterized statements?
- Is data properly validated before insert/update?
- Are migrations safe (up/down)?
- Are transactions used for multi-step operations?
- Is connection management handled properly?

## Checklist

### SQL Injection Prevention
- [ ] Do queries use parameterized statements?
- [ ] Is user input validated before being in queries?
- [ ] Are there any string concatenations with user data?

### Query Patterns
- [ ] Are there N+1 query issues (queries in loops)?
- [ ] Are indexes considered for frequent queries?
- [ ] Is pagination used for large result sets?

### Transaction Safety
- [ ] Are multi-step operations in transactions?
- [ ] Is error handling with rollback in place?
- [ ] Are connections properly released?

### Data Validation
- [ ] Is input validated before database insert?
- [ ] Are unique constraints checked?
- [ ] Is foreign key integrity maintained?

## Common Vulnerabilities

#### SQL Injection
```typescript
// VULNERABLE: String concatenation
const query = `SELECT * FROM users WHERE id = '${userId}'`

// SAFE: Parameterized query
const query = 'SELECT * FROM users WHERE id = $1'
```

#### N+1 Query
```typescript
// VULNERABLE: Query in loop
for (const id of userIds) {
  const user = await db.query(`SELECT * FROM users WHERE id = $1`, [id])
}

// SAFE: Batch query or JOIN
const users = await db.query('SELECT * FROM users WHERE id = ANY($1)', [userIds])
```

#### Missing Transaction
```typescript
// VULNERABLE: No transaction
await db.query('UPDATE accounts SET balance = balance - $1', [amount])
await db.query('INSERT INTO transactions...')

// SAFE: With transaction
const client = await db.connect()
try {
  await client.query('BEGIN')
  await client.query('UPDATE accounts...')
  await client.query('INSERT INTO transactions...')
  await client.query('COMMIT')
} catch (e) {
  await client.query('ROLLBACK')
  throw e
}
```

### Second-Order SQL Injection

Data stored safely but later retrieved and used unsafely in another query:
```typescript
// Step 1: Safe insert
db.query('INSERT INTO users (name) VALUES ($1)', [req.body.name])
// name = "'; DROP TABLE users; --"

// Step 2: Later retrieved and concatenated UNSAFELY in a different query
const user = await getUser(id)
db.query(`SELECT * FROM logs WHERE username = '${user.name}'`)  // 🔴 BOOM
```
Always parameterize even when the data "came from the database."

### Least Privilege
- Does the app connect using an account with only the permissions it needs?
- If there's SQL injection, what's the blast radius? Admin DB account = full compromise.

### Connection Strings in Logs
- Are DB credentials visible in error messages, stack traces, or application logs?
- Is the connection string accidentally committed to git?

## Notes

- Check for proper connection pooling
- Verify migrations have both up and down
- Look for hardcoded values that should be constants
- Check if sensitive fields are properly encrypted
