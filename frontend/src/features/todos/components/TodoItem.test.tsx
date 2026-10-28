import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoItem } from './TodoItem'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('shows an active task and forwards edit requests', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByText('To do')).toBeVisible()
  expect(screen.getByText('Medium')).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})

describe('TodoItem details', () => {
  afterEach(() => vi.useRealTimers())
  const renderItem = (
    todo: Todo,
    busy = false,
    handlers: { onToggle?: () => void; onDelete?: () => void } = {},
  ) =>
    render(
      <TodoItem
        todo={todo}
        busy={busy}
        onEdit={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        {...handlers}
      />,
    )

  it('shows a completed task with its description', () => {
    renderItem({ ...todoFixture, completed: true, description: 'Details' })
    expect(screen.getByText('Completed')).toBeVisible()
    expect(screen.getByText('Details')).toBeVisible()
    expect(
      screen.getByRole('checkbox', {
        name: `Mark as active: ${todoFixture.title}`,
      }),
    ).toBeChecked()
  })

  it('forwards toggle and delete requests', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onDelete = vi.fn()
    renderItem(todoFixture, false, { onToggle, onDelete })
    await user.click(screen.getByRole('checkbox'))
    await user.click(
      screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
    )
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('disables all actions while busy', () => {
    renderItem(todoFixture, true)
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(
      screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
    ).toBeDisabled()
  })

  it('marks an active task past its due date as overdue', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 16, 12) })
    renderItem({ ...todoFixture, due_date: '2026-10-15' })
    expect(screen.getByText(/15 Oct 2026/)).toHaveTextContent('· overdue')
  })

  it('does not mark a task due today as overdue', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 15, 23, 59) })
    renderItem({ ...todoFixture, due_date: '2026-10-15' })
    expect(screen.getByText(/15 Oct 2026/)).not.toHaveTextContent('overdue')
  })

  it('does not mark a completed past task as overdue', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 16, 12) })
    renderItem({ ...todoFixture, due_date: '2026-10-15', completed: true })
    expect(screen.getByText(/15 Oct 2026/)).not.toHaveTextContent('overdue')
  })
})
