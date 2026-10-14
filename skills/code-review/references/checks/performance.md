# Performance Checks

Load this file when reviewing performance-critical code, database queries, memory usage, or optimization opportunities.

## Key Questions

- Are there N+1 query patterns?
- Are loops efficient?
- Is memory properly managed?
- Is caching used appropriately?
- Are there memory leaks?

## Checklist

### Query Performance
- [ ] Are there queries inside loops (N+1)?
- [ ] Are indexes used for frequent queries?
- [ ] Are large result sets paginated?
- [ ] Are expensive queries cached?

### Memory Management
- [ ] Are large objects garbage collected?
- [ ] Are streams used for large data?
- [ ] Are event listeners properly removed?
- [ ] Are there memory leaks from closures?

### Loop Efficiency
- [ ] Are loops doing unnecessary work?
- [ ] Can operations be batched?
- [ ] Are there O(n²) algorithms in hot paths?
- [ ] Can caching reduce repeated computation?

### Caching
- [ ] Is expensive data cached appropriately?
- [ ] Is cache invalidation implemented?
- [ ] Is there a cache TTL to prevent stale data?

## Common Issues

#### N+1 Query
```typescript
// SLOW: Query per item
for (const order of orders) {
  const items = await db.query('SELECT * FROM items WHERE order_id = $1', [order.id])
}

// FAST: Single query with JOIN
const items = await db.query('SELECT * FROM items WHERE order_id = ANY($1)', [orderIds])
```

#### Memory Leak
```typescript
// LEAK: Growing array
const results = []
function process(data) {
  results.push(expensiveOperation(data))  // Grows forever
}

// SAFE: Limit or clear
const results = []
function process(data) {
  if (results.length < 1000) results.push(...)
}
```

## Notes

- Profile before optimizing
- Check for connection pool exhaustion
- Look for synchronous operations that could be async
- Verify caching doesn't cause stale data issues
