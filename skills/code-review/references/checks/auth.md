# Authentication & Authorization Checks

Load this file when reviewing code with authentication, authorization, or access control.

## Key Questions

- Is authentication required and enforced?
- Does the code verify the user has access to THIS specific resource?
- Can user A access user B's data (IDOR)?
- Are there privilege escalation possibilities?

## Checklist

### Authentication
- [ ] Is auth check at the top of every protected endpoint?
- [ ] Can auth check be bypassed (early returns, missing middleware)?
- [ ] Is the token/session validated correctly?
- [ ] Are there any routes without auth that should have it?

### Authorization (IDOR Prevention)
- [ ] Does the code verify resource ownership?
- [ ] Can parameter manipulation grant access to other users' data?
- [ ] Are `userId` params validated against the authenticated user?
- [ ] Do queries filter by `user_id` or just take it from client?

### Common Vulnerabilities

#### Broken Object Level Authorization (IDOR)
```typescript
// VULNERABLE: Takes leaderboardId from client
const data = await getLeaderboardData(leaderboardId, token)

// SAFE: Verifies ownership first
const data = await getLeaderboardData(userId, leaderboardId)
if (data.userId !== userId) return 403
```

#### Privilege Escalation
```typescript
// VULNERABLE: Trusts client-provided role
if (user.role === 'admin' || req.body.makeAdmin) { ... }

// SAFE: Role comes from verified token only
if (tokenClaims.role === 'admin') { ... }
```

#### Missing Access Checks
```typescript
// VULNERABLE: No user verification
async function getData(id: string) {
  return db.query(`SELECT * FROM data WHERE id = '${id}'`)
}

// SAFE: Verifies ownership
async function getData(userId: string, id: string) {
  return db.query(`SELECT * FROM data WHERE id = $1 AND user_id = $2`, [id, userId])
}
```

### JWT-Specific Issues

```typescript
// VULNERABLE: Accepts alg:none — token unsigned, attacker modifies payload
jwt.verify(token, secret)  // if library doesn't reject alg:none

// SAFE: Enforce algorithm explicitly
jwt.verify(token, secret, { algorithms: ['RS256'] })
```

Other JWT checks:
- **Missing expiry validation** — is `exp` claim actually checked, not just trusted?
- **Algorithm confusion** — RS256 → HS256 swap using the public key as HMAC secret
- **Case variations** — filters bypassed with `NonE`, `NONE` if whitelist is naive string match
- **Parsing before verifying** — don't decode and use payload fields before signature is confirmed

### Session Issues
- Are session tokens rotated on privilege escalation (login, role change)?
- Are old sessions invalidated on logout or password change?
- Is the session token entropy sufficient (≥128 bits, cryptographic RNG)?

## Notes

- Always trace how `userId` flows from request → query
- Check if queries use parameterized queries or string concatenation
- Verify role checks come from server-side tokens, not client requests
- Look for race conditions where auth check passes but data changes before query
