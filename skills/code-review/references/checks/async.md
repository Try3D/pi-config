# Async & Concurrency Checks

Load this file when reviewing asynchronous code, promises, async/await, workers, or any concurrent operations.

## Key Questions

- Are all async operations properly awaited?
- Are promises handled correctly (no unhandled rejections)?
- Are there race conditions in concurrent access?
- Are resources properly cleaned up?
- Are callbacks handled safely?

## Checklist

### Promise Handling
- [ ] Are all promises awaited where needed?
- [ ] Are there unhandled promise rejections?
- [ ] Are errors in async functions properly caught?
- [ ] Is there missing `.catch()` on promise chains?

### Race Conditions
- [ ] Is there concurrent access to shared state?
- [ ] Are writes protected by locks or atomic operations?
- [ ] Is the check-then-act pattern used safely?
- [ ] Are cache invalidations race-condition-safe?

### Resource Management
- [ ] Are connections/streams properly closed?
- [ ] Are timeouts set for long-running operations?
- [ ] Are there memory leaks from unclosed resources?

### Callback Safety
- [ ] Are callbacks invoked exactly once?
- [ ] Are errors passed to callbacks?
- [ ] Is the callback called after function return?

## Common Bugs

#### Missing Await
```typescript
// BUG: Function returns before async completes
async function processData(data) {
  await saveToDb(data)
  sendNotification(data)  // Missing await!
  return { success: true }
}

// FIXED: All operations awaited
async function processData(data) {
  await saveToDb(data)
  await sendNotification(data)
  return { success: true }
}
```

#### Race Condition
```typescript
// BUG: Check-then-act race condition
if (!cache.has(key)) {
  const result = await fetchData()  // Another call might also enter here
  cache.set(key, result)
}

// FIXED: Atomic check-and-set
const result = await cache.getOrSet(key, async () => fetchData())
```

#### Unhandled Rejection
```typescript
// BUG: Unhandled promise rejection
async function handler(req, res) {
  someAsyncCall()  // If this throws, process crashes
  res.json({ success: true })
}

// FIXED: Proper error handling
async function handler(req, res) {
  try {
    await someAsyncCall()
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Failed' })
  }
}
```

## Notes

- Look for `async` functions without `await` inside
- Check for `Promise.all` vs sequential awaits
- Verify error boundaries for async operations
- Check for memory leaks in long-running processes
