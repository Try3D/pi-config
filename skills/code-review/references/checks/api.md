# API Endpoint Checks

Load this file when reviewing HTTP endpoints, request/response handling, or REST APIs.

## Key Questions

- Are HTTP methods validated (GET/POST/PUT/DELETE)?
- Is request body validated before processing?
- Are error responses safe (no stack traces)?
- Is rate limiting implemented for expensive operations?
- Are HTTP status codes correct?

## Checklist

### HTTP Method Handling
- [ ] Does the endpoint validate `req.method`?
- [ ] Are unsupported methods properly rejected (405)?
- [ ] Is CORS handled correctly for cross-origin requests?

### Request Validation
- [ ] Are required fields checked before processing?
- [ ] Is input sanitized early and consistently?
- [ ] Are type conversions handled safely?
- [ ] Are edge cases checked (empty strings, null values)?

### Response Safety
- [ ] Are error messages user-friendly, not revealing internals?
- [ ] Are stack traces excluded from responses?
- [ ] Are HTTP status codes semantically correct?
- [ ] Is sensitive data filtered from responses?

### Rate Limiting
- [ ] Are expensive operations rate-limited?
- [ ] Is there protection against abuse (AI generation, etc.)?
- [ ] Is caching used appropriately?

### Common Vulnerabilities

#### Missing Method Check
```typescript
// VULNERABLE: Assumes POST
async function handler(req, res) {
  // Process request...
}

// SAFE: Validate method first
async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  // Process request...
}
```

#### Information Leakage in Errors
```typescript
// VULNERABLE: Exposes internals
} catch (error) {
  return res.status(500).json({ error: error.stack })
}

// SAFE: Generic error message
} catch (error) {
  console.error('Internal error:', error)
  return res.status(500).json({ error: 'Internal server error' })
}
```

#### Missing Input Validation
```typescript
// VULNERABLE: Trusts client input
const { userId, data } = req.body

// SAFE: Validate required fields
const { userId, data } = req.body
if (!userId || !data) {
  return res.status(400).json({ error: 'userId and data required' })
}
```

### BOLA / BFLA (Broken Object & Function Level Authorization)

```typescript
// BOLA: Attacker changes ID to access another user's resource
GET /invoices/456  // Should check 456 belongs to the authenticated user

// BFLA: Regular user calls admin action
POST /admin/delete-user  // Role check missing or misconfigured
```

### Mass Assignment

```typescript
// VULNERABLE: Spread of req.body directly into model
await User.update({ ...req.body }, { where: { id } })
// Attacker sends { role: 'admin', balance: 99999 }

// SAFE: Explicitly pick allowed fields
const { name, email } = req.body
await User.update({ name, email }, { where: { id } })
```

### Additional Checks
- **Inconsistent auth per method** — GET protected but PATCH unprotected on same route?
- **Content-Type validation** — is `application/json` enforced to prevent CSRF?
- **Request body size limits** — can client send a 1GB payload?
- **Versioning** — does removing or adding a field break existing clients silently?

## Notes

- Check for consistent error response format
- Verify all endpoints have proper error handling
- Look for blocking operations in async handlers
- Check CORS settings for sensitive endpoints
