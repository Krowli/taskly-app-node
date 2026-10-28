import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { TodoList } from './TodoList'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('./TodoEmptyState', () => ({
  TodoEmptyState: () => <p>Empty task list</p>,
}))
vi.mock('./TodoItem', () => ({ TodoItem: () => <li>Task</li> }))

it('shows loading feedback before showing an empty list', () => {
  const props = {
    todos: [],
    hasTodos: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
  const { rerender } = render(<TodoList {...props} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading your tasks…')
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
  rerender(<TodoList {...props} loading={false} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByText('Empty task list')).toBeVisible()
})

describe('TodoList states', () => {
  const props = {
    todos: [],
    hasTodos: false,
    loading: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }

  it('shows an unavailable message when loading failed without data', () => {
    render(<TodoList {...props} failed />)
    expect(
      screen.getByRole('heading', {
        name: 'The task list is temporarily unavailable',
      }),
    ).toBeVisible()
    expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
  })

  it('keeps showing the loaded tasks when a refetch failed', () => {
    render(<TodoList {...props} failed hasTodos todos={[todoFixture]} />)
    expect(screen.getByText('Task')).toBeVisible()
    expect(screen.queryByText(/temporarily unavailable/)).not.toBeInTheDocument()
  })

  it('shows the empty state when failed but tasks exist and none match', () => {
    render(<TodoList {...props} failed hasTodos />)
    expect(screen.getByText('Empty task list')).toBeVisible()
  })

  it('renders one item per task', () => {
    render(
      <TodoList
        {...props}
        hasTodos
        todos={[todoFixture, { ...todoFixture, id: 8 }]}
      />,
    )
    expect(screen.getAllByText('Task')).toHaveLength(2)
  })
})
