---
name: writing-frontend-tests
description: Conventions, module-boundary mocks and techniques for Vitest + React Testing Library tests in frontend/ — rendering with the mocked design system, stubbed child components and hooks, TanStack Query hooks with a fresh client, the API module and fetch boundaries, timers, dates and module-level side effects. Use before creating or editing any *.test.ts or *.test.tsx under frontend/src, or when a frontend test fails for setup reasons.
---

# Writing frontend tests

Frontend tests render real components with a mocked design system and test hooks through their results, querying the DOM the way users find things. Match the repo style: Prettier with no semicolons, single quotes and trailing commas. Choose the cases with `analyzing-pr-changes`; this skill covers how to write them.

## Conventions

- Co-locate: `X.tsx` → `X.test.tsx`, `x.ts` → `x.test.ts`; `.tsx` when the test contains JSX. Import without extensions.
- Import from Vitest explicitly: `import { expect, it, vi } from 'vitest'`. `src/test/setup.ts` already registers jest-dom and `cleanup`.
- Fixture: `todoFixture` from `src/test/todoFixture.ts`; make variants with spread instead of editing it. Interactions: `const user = userEvent.setup()`, and `await` every `user.*` call; `waitFor` for async state.
- Queries: `getByRole` with a `name` → `getByLabelText` → `getByText`; `toBeVisible()` / `toBeInTheDocument()`. Never class names or styles.

## Boundaries

- **Design system:** `vi.mock('../../../design-system', () => import('../../../design-system/mocks'))`, path relative to the test. The mocks render native elements (`Drawer` becomes `role="dialog"` named by its title). Do not test design-system internals; they are excluded from coverage.
- **Pages and containers:** mock child components and hooks (as in `frontend/src/features/todos/TodosPage.test.tsx`). A stub renders the props the test checks and names its controls with them, e.g. `<button onClick={() => onToggle(todo)}>Toggle {todo.title}</button>`, so the test proves which item the page passed.
- **API:** the feature API module mocks the HTTP layer, `vi.mock('../../../lib/http', () => ({ request: vi.fn() }))`; hooks mock the feature API module (`todosApi`, one `vi.fn()` per method).
- **fetch** (only for the HTTP layer itself): `vi.stubGlobal('fetch', vi.fn())` returning `new Response(JSON.stringify(body), { status })`, and `vi.unstubAllGlobals()` in `afterEach`.

## TanStack Query hooks

Give every test a fresh client with no retries; a shared client leaks state between tests:

```tsx
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}
```

Seed the cache with `queryClient.setQueryData(key, …)`, run mutations inside `act`, then assert `queryClient.getQueryData(key)` and the API call. For a pending state, give the mock a promise that never resolves; for a hook that reads another hook's state, render both in one `renderHook`.

## Hard-to-reach code

- **Timers and delayed effects:** `vi.useFakeTimers()`, advance inside `act`, `vi.useRealTimers()` in `afterEach`; assert just before the delay and at it.
- **Dates:** `vi.setSystemTime(new Date(2026, 9, 15, 12))` (local time). Mid-day by default; when behaviour should depend only on the calendar date, add just after and just before midnight. Real timers in date logic pass today and fail at midnight.
- **Module-level side effects** (a value computed on import): set the input, then `vi.resetModules()` and `await import('./module')` inside the test (a literal path).
- **Handlers passed down to children:** render the real child, or a stub that calls the prop, and act on it through its accessible role.
- **A guard the UI cannot trigger** (a click on a disabled button): name it and say why in `decisions`, instead of forcing it.
