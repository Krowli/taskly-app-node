import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { Todo } from '../types'
import { useCreateTodoMutation } from './useCreateTodoMutation'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'
import { useTodosBusy } from './useTodosBusy'
import { useTodosQuery } from './useTodosQuery'
import { useUpdateTodoMutation } from './useUpdateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))
beforeEach(() => vi.clearAllMocks())

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}
const other: Todo = { ...todoFixture, id: 8, title: 'Other' }

describe('useTodosQuery', () => {
  it('loads tasks and passes the abort signal', async () => {
    vi.mocked(todosApi.list).mockResolvedValue([todoFixture])
    const { wrapper } = setup()
    const { result } = renderHook(() => useTodosQuery(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual([todoFixture]))
    expect(todosApi.list).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('exposes a failed load as an error', async () => {
    vi.mocked(todosApi.list).mockRejectedValue(new Error('down'))
    const { wrapper } = setup()
    const { result } = renderHook(() => useTodosQuery(), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toBe('down'))
  })
})

describe('useCreateTodoMutation', () => {
  it('puts the saved task first and replaces a stale copy with the same id', async () => {
    const saved = { ...todoFixture, title: 'Fresh' }
    vi.mocked(todosApi.create).mockResolvedValue(saved)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [other, todoFixture])
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(todoFixture))
    expect(todosApi.create).toHaveBeenCalledWith(todoFixture)
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([saved, other])
  })

  it('creates the list when nothing is cached', async () => {
    vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(todoFixture))
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })

  it('leaves the cache unchanged when creation fails', async () => {
    vi.mocked(todosApi.create).mockRejectedValue(new Error('fail'))
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [other])
    const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
    await act(async () => {
      await expect(result.current.mutateAsync(todoFixture)).rejects.toThrow(
        'fail',
      )
    })
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([other])
  })
})

describe('useUpdateTodoMutation', () => {
  it('replaces only the saved task in the cache', async () => {
    const saved = { ...todoFixture, completed: true }
    vi.mocked(todosApi.update).mockResolvedValue(saved)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [other, todoFixture])
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
    await act(() =>
      result.current.mutateAsync({ id: 7, input: { completed: true } }),
    )
    expect(todosApi.update).toHaveBeenCalledWith(7, { completed: true })
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([other, saved])
  })

  it('does not create a list when none is cached', async () => {
    vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync({ id: 7, input: {} }))
    expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
  })

  it('exposes the error and keeps the cache when the update fails', async () => {
    vi.mocked(todosApi.update).mockRejectedValue(new Error('fail'))
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [todoFixture])
    const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: 7, input: {} }),
      ).rejects.toThrow('fail')
    })
    await waitFor(() => expect(result.current.error?.message).toBe('fail'))
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})

describe('useDeleteTodoMutation', () => {
  it('removes the deleted task from the cache', async () => {
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [other, todoFixture])
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(7))
    expect(todosApi.remove).toHaveBeenCalledWith(7)
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([other])
  })

  it('does not create a list when none is cached', async () => {
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
    await act(() => result.current.mutateAsync(7))
    expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
  })

  it('keeps the task when deletion fails', async () => {
    vi.mocked(todosApi.remove).mockRejectedValue(new Error('fail'))
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(todoKeys.list, [todoFixture])
    const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
    await act(async () => {
      await expect(result.current.mutateAsync(7)).rejects.toThrow('fail')
    })
    expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})

describe('useTodosBusy', () => {
  it('is idle without mutations', () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useTodosBusy(), { wrapper })
    expect(result.current).toBe(false)
  })

  it('is busy while a task mutation runs and idle after it settles', async () => {
    let finish: (todo: Todo) => void = () => {}
    vi.mocked(todosApi.update).mockReturnValue(
      new Promise<Todo>((resolve) => {
        finish = resolve
      }),
    )
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({ busy: useTodosBusy(), update: useUpdateTodoMutation() }),
      { wrapper },
    )
    let pending: Promise<Todo> = Promise.resolve(todoFixture)
    act(() => {
      pending = result.current.update.mutateAsync({ id: 7, input: {} })
    })
    await waitFor(() => expect(result.current.busy).toBe(true))
    await act(async () => {
      finish(todoFixture)
      await pending
    })
    await waitFor(() => expect(result.current.busy).toBe(false))
  })
})
