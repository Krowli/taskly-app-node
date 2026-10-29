import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { request } from '../../../lib/http'
import { useTodoStatsQuery } from '../hooks/useTodoStatsQuery'
import { todoKeys } from './queryKeys'
import { todosApi } from './todos'

vi.mock('../../../lib/http', () => ({ request: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

const stats = { total: 4, completed: 1, active: 3, overdue: 2 }

it('requests statistics with the abort signal', async () => {
  const signal = new AbortController().signal
  vi.mocked(request).mockResolvedValue(stats)
  await expect(todosApi.stats(signal)).resolves.toEqual(stats)
  expect(request).toHaveBeenCalledWith('/todos/stats', { signal })
})

it('stores statistics under the stats key, separate from the list', async () => {
  vi.mocked(request).mockResolvedValue(stats)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useTodoStatsQuery(), { wrapper })
  await waitFor(() => expect(result.current.data).toEqual(stats))
  expect(queryClient.getQueryData(todoKeys.stats)).toEqual(stats)
  expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
  expect(todoKeys.stats).not.toEqual(todoKeys.list)
})
