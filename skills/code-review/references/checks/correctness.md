# Correctness & Logic Checks

Load this file for general bug detection, edge cases, null handling, and general code logic issues.

## Key Questions

- Are null/undefined values handled before use?
- Are errors caught and handled appropriately?
- Are type conversions safe?
- Are edge cases covered (empty input, boundary values)?
- Is the code logic correct (no off-by-one, etc.)?

## Checklist

### Null/Undefined Handling
- [ ] Are function parameters validated?
- [ ] Are return values checked before use?
- [ ] Are optional fields handled safely?
- [ ] Is there defensive programming?

### Error Handling
- [ ] Are errors caught at appropriate levels?
- [ ] Are caught errors logged?
- [ ] Are errors re-thrown when appropriate?
- [ ] Are generic catches too broad?

### Type Safety
- [ ] Are type conversions explicit?
- [ ] Are there type coercion bugs?
- [ ] Is TypeScript strict mode enabled?
- [ ] Are there any `any` types that should be specific?

### Edge Cases
- [ ] Empty collections (arrays, maps, sets)
- [ ] Division by zero
- [ ] Empty strings, whitespace-only strings
- [ ] Boundary values (min/max)
- [ ] Concurrent access to shared state

### Common Bugs

#### Null Pointer
```typescript
// BUG: Accessing property on potentially null value
const name = user.getProfile().name  // Fails if getProfile() returns null

// SAFE: Null check
const profile = user.getProfile()
const name = profile?.name ?? 'Unknown'
```

#### Swallowed Errors
```typescript
// BUG: Error swallowed without logging
try {
  await doSomething()
} catch (e) {
  // Silently ignored
}

// SAFE: Log and handle
try {
  await doSomething()
} catch (e) {
  console.error('Operation failed:', e)
  throw e  // Or handle appropriately
}
```

#### Off-by-One
```typescript
// BUG: Off-by-one in loop
for (let i = 0; i <= array.length; i++) {  // Extra iteration
  process(array[i])
}

// SAFE: Correct bounds
for (let i = 0; i < array.length; i++) {
  process(array[i])
}
```

## Notes

- Check for `!userId` style checks that don't handle all falsy values
- Look for `Array.isArray()` before array operations
- Verify string comparisons use correct equality
- Check for missing default values in destructuring
