import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useTodoFilters } from './useTodoFilters'

const done = { ...todoFixture, id: 8, title: 'Finished', completed: true }

it('starts with all tasks sorted by newest', () => {
  const { result } = renderHook(() => useTodoFilters([todoFixture, done]))
  expect(result.current.filter).toBe('all')
  expect(result.current.search).toBe('')
  expect(result.current.sort).toBe('newest')
  expect(result.current.visible.map((t) => t.id)).toEqual([8, 7])
})

it('narrows the visible tasks by filter and search', () => {
  const { result } = renderHook(() => useTodoFilters([todoFixture, done]))
  act(() => result.current.setFilter('completed'))
  expect(result.current.visible).toEqual([done])
  act(() => result.current.setFilter('all'))
  act(() => result.current.setSearch('demo'))
  expect(result.current.visible).toEqual([todoFixture])
})

it('re-sorts the visible tasks', () => {
  const high = { ...todoFixture, id: 3, priority: 'high' as const }
  const { result } = renderHook(() => useTodoFilters([todoFixture, high]))
  act(() => result.current.setSort('priority'))
  expect(result.current.sort).toBe('priority')
  expect(result.current.visible.map((t) => t.id)).toEqual([3, 7])
})
