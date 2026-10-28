import { describe, expect, it } from 'vitest'
import { afterEach, vi } from 'vitest'
import { selectTodos } from './todos'
import { formatDate, isOverdue, validateTodo } from './todos'
import type { Todo } from '../types'

const base: Todo = {
  id: 1,
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  completed: false,
  due_date: null,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
}

describe('selectTodos', () => {
  it('combines status with a case-insensitive search in the description', () => {
    const matching = { ...base, description: 'Discuss the API' }
    const todos = [
      matching,
      { ...matching, id: 2, completed: true },
      { ...base, id: 3 },
    ]
    expect(selectTodos(todos, 'active', ' api ', 'newest')).toEqual([matching])
  })

  it('sorts by priority without changing the source array', () => {
    const high: Todo = { ...base, id: 2, priority: 'high' }
    const todos = [base, high]
    expect(selectTodos(todos, 'all', '', 'priority')).toEqual([high, base])
    expect(todos).toEqual([base, high])
  })
})

describe('validateTodo', () => {
  const valid = {
    title: 'Plan',
    description: '',
    priority: 'medium' as const,
    due_date: null,
    completed: false,
  }

  it('accepts a valid task', () => {
    expect(validateTodo(valid)).toEqual({})
  })

  it.each([
    ['', 'Enter a task title.'],
    ['   ', 'Enter a task title.'],
    ['x'.repeat(121), 'The title must be at most 120 characters.'],
    [` ${'x'.repeat(121)} `, 'The title must be at most 120 characters.'],
  ])('rejects title %j', (title, message) => {
    expect(validateTodo({ ...valid, title })).toEqual({ title: message })
  })

  it('accepts a title of exactly 120 characters', () => {
    expect(validateTodo({ ...valid, title: 'x'.repeat(120) })).toEqual({})
  })

  it('limits the trimmed description to 2000 characters', () => {
    expect(
      validateTodo({ ...valid, description: ` ${'x'.repeat(2000)} ` }),
    ).toEqual({})
    expect(validateTodo({ ...valid, description: 'x'.repeat(2001) })).toEqual({
      description: 'The description must be at most 2000 characters.',
    })
  })

  it.each(['2026-02-30', '2026-13-01', '26-10-01', '2026-1-1', 'tomorrow'])(
    'rejects the invalid due date %s',
    (due_date) => {
      expect(validateTodo({ ...valid, due_date })).toEqual({
        due_date: 'Enter a valid date.',
      })
    },
  )

  it.each(['2026-10-15', '2028-02-29'])(
    'accepts the due date %s',
    (due_date) => {
      expect(validateTodo({ ...valid, due_date })).toEqual({})
    },
  )
})

describe('selectTodos ordering', () => {
  const at = (id: number, extra: Partial<Todo>): Todo => ({
    ...base,
    id,
    ...extra,
  })

  it('filters completed tasks', () => {
    const done = at(2, { completed: true })
    expect(selectTodos([base, done], 'completed', '', 'newest')).toEqual([done])
  })

  it('matches the search in the title', () => {
    const other = at(2, { title: 'Other' })
    expect(selectTodos([base, other], 'all', 'SPRINT', 'newest')).toEqual([
      base,
    ])
  })

  it('sorts newest first and breaks ties by higher id', () => {
    const older = at(2, { created_at: '2026-09-01T12:00:00Z' })
    const tie = at(3, {})
    expect(
      selectTodos([older, base, tie], 'all', '', 'newest').map((t) => t.id),
    ).toEqual([3, 1, 2])
  })

  it('sorts by priority high, medium, low with ties by higher id', () => {
    const low = at(2, { priority: 'low' })
    const high = at(3, { priority: 'high' })
    const medium = at(4, {})
    expect(
      selectTodos([low, base, high, medium], 'all', '', 'priority').map(
        (t) => t.id,
      ),
    ).toEqual([3, 4, 1, 2])
  })

  it('sorts by due date with undated tasks last', () => {
    const late = at(2, { due_date: '2026-12-01' })
    const early = at(3, { due_date: '2026-10-01' })
    const sameDay = at(4, { due_date: '2026-10-01' })
    expect(
      selectTodos([base, late, early, sameDay], 'all', '', 'due').map(
        (t) => t.id,
      ),
    ).toEqual([4, 3, 2, 1])
  })
})

describe('isOverdue', () => {
  afterEach(() => vi.useRealTimers())
  const due = (due_date: string | null, completed = false): Todo => ({
    ...base,
    due_date,
    completed,
  })

  it.each([
    new Date(2026, 9, 15, 0, 0, 1),
    new Date(2026, 9, 15, 12),
    new Date(2026, 9, 15, 23, 59, 59),
  ])('is not overdue on its due date (%s)', (now) => {
    vi.useFakeTimers({ now })
    expect(isOverdue(due('2026-10-15'))).toBe(false)
  })

  it('is overdue the day after its due date', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 16, 0, 0, 1) })
    expect(isOverdue(due('2026-10-15'))).toBe(true)
  })

  it('handles month and year boundaries', () => {
    vi.useFakeTimers({ now: new Date(2027, 0, 1, 12) })
    expect(isOverdue(due('2026-12-31'))).toBe(true)
    expect(isOverdue(due('2027-01-01'))).toBe(false)
  })

  it('is not overdue when completed or without a due date', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 16, 12) })
    expect(isOverdue(due('2026-10-15', true))).toBe(false)
    expect(isOverdue(due(null))).toBe(false)
  })
})

describe('formatDate', () => {
  it('formats a calendar date in en-GB style', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026')
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026')
  })
})

describe('selectTodos due-date comparison', () => {
  const at = (id: number, due_date: string | null): Todo => ({
    ...base,
    id,
    due_date,
  })

  it.each([
    ['dated first', [at(1, '2026-10-01'), at(2, null)]],
    ['undated first', [at(2, null), at(1, '2026-10-01')]],
  ])('puts the undated task last when %s', (_name, todos) => {
    expect(selectTodos(todos, 'all', '', 'due').map((t) => t.id)).toEqual([
      1, 2,
    ])
  })
})
