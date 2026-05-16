# Node Connector Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make single-node and single-word-node links render as pure straight lines while multi-child branches render as shared-trunk orthogonal branches, without changing node visuals or editor behavior.

**Architecture:** Keep the existing G6 node layout and editor lifecycle intact. Restrict changes to `lib/utils/g6.ts` edge routing decisions plus direct regression tests in `tests/g6-position.test.ts`, with one supporting style assertion update if needed.

**Tech Stack:** Next.js, React, TypeScript, AntV G6, Vitest

---

### Task 1: Lock Desired Branching Behavior In Tests

**Files:**
- Modify: `tests/g6-position.test.ts`
- Test: `tests/g6-position.test.ts`

- [ ] **Step 1: Write the failing test updates**

Add or update tests so they assert:

```ts
it('keeps a single-word child on a straight line when it is the only child', async () => {
  // parent -> "词" stays type: 'line'
});

it('keeps every child in a multi-child branch on orthogonal routing, including the centered child', async () => {
  // parent -> child-a / child-b / child-c are all type: 'polyline'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/g6-position.test.ts`

Expected:
- Existing multi-child centered-edge assertion fails because current code promotes the centered child to `line`
- New single-word / branch assertions fail if not yet implemented

- [ ] **Step 3: Commit the failing test state mentally and do not patch production code yet**

No commit yet. Move directly to the minimal implementation in Task 2.

### Task 2: Minimize Edge Routing Logic Changes

**Files:**
- Modify: `lib/utils/g6.ts`
- Test: `tests/g6-position.test.ts`

- [ ] **Step 1: Implement the smallest routing change**

Update the grouped-child logic so:

```ts
if (childIds.length === 1) {
  // keep existing straight-line behavior for single-child branches
}

if (childIds.length > 1) {
  // always emit type: 'polyline'
  // keep shared parent source port
  // do not special-case the centered child back to 'line'
}
```

- [ ] **Step 2: Keep scope tight**

Do not change:

```ts
getNodeSize(...)
node fill / stroke / radius in components/mindmap-editor.tsx
editor drag/edit/save behavior
```

- [ ] **Step 3: Run the focused test file**

Run: `npm test -- tests/g6-position.test.ts`

Expected: PASS

### Task 3: Align Supporting Style Assertions

**Files:**
- Modify: `tests/mindmap-editor-styles.test.ts` (only if needed)
- Test: `tests/mindmap-editor-styles.test.ts`

- [ ] **Step 1: Update stale assertions if they encode the old centered-child behavior**

Keep assertions focused on current edge styling primitives, for example:

```ts
expect(source).toMatch(/type:\s*'orth'\s+as const/);
```

- [ ] **Step 2: Run the style test**

Run: `npm test -- tests/mindmap-editor-styles.test.ts`

Expected: PASS

### Task 4: Verify Integration-Safe Behavior

**Files:**
- Modify: none unless a regression is found
- Test: `tests/g6-position.test.ts`, `tests/mindmap-editor-styles.test.ts`

- [ ] **Step 1: Run the focused regression suite**

Run: `npm test -- tests/g6-position.test.ts tests/mindmap-editor-styles.test.ts`

Expected: PASS

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck`

Expected: PASS

- [ ] **Step 3: Perform manual smoke verification in the editor**

Verify these scenarios visually:

```text
1. single node -> single child: straight line
2. single node -> single-word child: straight line
3. single node -> multiple children: all children share one branch trunk
4. nested child with its own single child: nested edge remains straight
5. nested child with multiple children: nested branch also shares one trunk
```

- [ ] **Step 4: Summarize unrelated failures explicitly if full-suite issues remain**

If any broader tests fail outside connector routing, call them out as pre-existing or unrelated before delivery.
