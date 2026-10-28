import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoList } from './TodoList'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('./TodoEmptyState', () => ({ TodoEmptyState: () => null }))
vi.mock('./TodoItem', () => ({
  TodoItem: ({
    todo,
    busy,
    onToggle,
    onEdit,
    onDelete,
  }: {
    todo: Todo
    busy: boolean
    onToggle: () => void
    onEdit: () => void
    onDelete: () => void
  }) => (
    <li>
      <span>
        {todo.title} busy={String(busy)}
      </span>
      <button onClick={onToggle}>Toggle {todo.title}</button>
      <button onClick={onEdit}>Edit {todo.title}</button>
      <button onClick={onDelete}>Delete {todo.title}</button>
    </li>
  ),
}))

it('passes the clicked task to the toggle, edit and delete handlers', async () => {
  const user = userEvent.setup()
  const first = { ...todoFixture, id: 1, title: 'First' }
  const second = { ...todoFixture, id: 2, title: 'Second' }
  const onToggle = vi.fn()
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoList
      todos={[first, second]}
      hasTodos
      loading={false}
      failed={false}
      busy
      onCreate={vi.fn()}
      onToggle={onToggle}
      onEdit={onEdit}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByText('Second busy=true')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Toggle Second' }))
  await user.click(screen.getByRole('button', { name: 'Edit First' }))
  await user.click(screen.getByRole('button', { name: 'Delete Second' }))
  expect(onToggle).toHaveBeenCalledExactlyOnceWith(second)
  expect(onEdit).toHaveBeenCalledExactlyOnceWith(first)
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(second)
})
