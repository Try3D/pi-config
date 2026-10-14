# UI & Component Checks

Load this file when reviewing frontend code, UI components, React/Vue/Angular components, or state management.

## Key Questions

- Is state properly managed?
- Are components handling loading/error states?
- Is user input validated before submission?
- Are there XSS vulnerabilities in user-generated content?
- Are there memory leaks in event listeners or subscriptions?

## Checklist

### Component State
- [ ] Are loading states handled?
- [ ] Are error states displayed appropriately?
- [ ] Is initial state defined?
- [ ] Are there race conditions in state updates?

### User Input
- [ ] Is form input validated before submission?
- [ ] Are XSS threats handled for user-generated content?
- [ ] Are there CSRF protections for mutations?

### Resource Management
- [ ] Are event listeners cleaned up on unmount?
- [ ] Are subscriptions properly terminated?
- [ ] Are timers/interval cleared?
- [ ] Are modal/drawer states managed?

### Performance
- [ ] Is list virtualization used for large lists?
- [ ] Are memo/callbacks properly used?
- [ ] Is re-render minimized?
- [ ] Are large images optimized?

## Common Bugs

#### Memory Leak from Event Listener
```typescript
// LEAK: Event listener not removed
useEffect(() => {
  window.addEventListener('resize', handleResize)
  // Missing cleanup!
}, [])

// SAFE: Cleanup in return
useEffect(() => {
  window.addEventListener('resize', handleResize)
  return () => window.removeEventListener('resize', handleResize)
}, [])
```

#### XSS in User Content
```typescript
// VULNERABLE: Raw HTML from user
dangerouslySetInnerHTML={{ __html: userContent }}

// SAFE: Sanitize or use text content
<span>{userContent}</span>
// Or use DOMPurify
```

## Notes

- Check for proper cleanup in useEffect/useLayoutEffect
- Verify form validation before API calls
- Look for hardcoded timeouts that could drift
- Check for proper error boundaries
