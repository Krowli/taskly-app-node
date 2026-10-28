import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../test/todoFixture'
import { useNotice } from '../../hooks/useNotice'
import { useTodoFilters } from './hooks/useTodoFilters'
import { useTodosBusy } from './hooks/useTodosBusy'
import { useTodosQuery } from './hooks/useTodosQuery'
import { useUpdateTodoMutation } from './hooks/useUpdateTodoMutation'
import { TodosPage } from './TodosPage'
import type { Todo } from './types'

vi.mock('../../design-system', () => import('../../design-system/mocks'))
vi.mock('../../hooks/useNotice', () => ({ useNotice: vi.fn() }))
vi.mock('./hooks/useTodoFilters', () => ({ useTodoFilters: vi.fn() }))
vi.mock('./hooks/useTodosBusy', () => ({ useTodosBusy: vi.fn() }))
vi.mock('./hooks/useTodosQuery', () => ({ useTodosQuery: vi.fn() }))
vi.mock('./hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./components/TodosHeader', () => ({
  TodosHeader: ({
    disabled,
    onCreate,
  }: {
    disabled: boolean
    onCreate: () => void
  }) => (
    <button disabled={disabled} onClick={onCreate}>
      Header create
    </button>
  ),
}))
vi.mock('./components/TodoFilters', () => ({
  TodoFilters: ({ filter, search }: { filter: string; search: string }) => (
    <p>
      Filters {filter}/{search}
    </p>
  ),
}))
vi.mock('./components/TodoList', () => ({
  TodoList: (props: {
    todos: Todo[]
    hasTodos: boolean
    loading: boolean
    failed: boolean
    busy: boolean
    onCreate: () => void
    onToggle: (todo: Todo) => void
    onEdit: (todo: Todo) => void
    onDelete: (todo: Todo) => void
  }) => (
    <div>
      <p>
        List loading={String(props.loading)} failed={String(props.failed)}{' '}
        hasTodos={String(props.hasTodos)} busy={String(props.busy)} count=
        {props.todos.length}
      </p>
      <button onClick={props.onCreate}>List create</button>
      {props.todos.map((todo) => (
        <div key={todo.id}>
          <button onClick={() => props.onToggle(todo)}>
            Toggle {todo.title}
          </button>
          <button onClick={() => props.onEdit(todo)}>Edit {todo.title}</button>
          <button onClick={() => props.onDelete(todo)}>
            Delete {todo.title}
          </button>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('./components/TodoEditor', () => ({
  TodoEditor: ({
    todo,
    onClose,
    onSaved,
  }: {
    todo: Todo | 'new'
    onClose: () => void
    onSaved: (message: string) => void
  }) => (
    <div role="dialog" aria-label="Editor">
      <p>Editing {todo === 'new' ? 'new' : todo.title}</p>
      <button onClick={onClose}>Close editor</button>
      <button onClick={() => onSaved('Saved!')}>Save editor</button>
    </div>
  ),
}))
vi.mock('./components/DeleteTodoDialog', () => ({
  DeleteTodoDialog: ({
    todo,
    onClose,
    onDeleted,
  }: {
    todo: Todo
    onClose: () => void
    onDeleted: () => void
  }) => (
    <div role="dialog" aria-label="Deleting">
      <p>Deleting {todo.title}</p>
      <button onClick={onClose}>Close delete</button>
      <button onClick={onDeleted}>Confirm delete</button>
    </div>
  ),
}))
vi.mock('../../components/SuccessNotice', () => ({
  SuccessNotice: ({ message }: { message: string }) => <p>Notice: {message}</p>,
}))

const notify = vi.fn()
const mutateAsync = vi.fn()
const reset = vi.fn()

function arrange({
  busy = false,
  pending = false,
  todos = [todoFixture],
  mutationError = null as Error | null,
  queryError = null as Error | null,
  fetching = false,
} = {}) {
  vi.mocked(useTodosQuery).mockReturnValue({
    data: todos,
    isPending: pending,
    isFetching: fetching,
    isError: Boolean(queryError),
    error: queryError,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: mutationError,
    reset,
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(busy)
  vi.mocked(useNotice).mockReturnValue({ message: 'Hello', notify })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'active',
    search: 'abc',
    sort: 'newest',
    visible: todos,
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
}

beforeEach(() => vi.clearAllMocks())

it('marks an active task complete and notifies', async () => {
  const user = userEvent.setup()
  arrange()
  mutateAsync.mockResolvedValue({ ...todoFixture, completed: true })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /Toggle/ }))
  expect(mutateAsync).toHaveBeenCalledWith({
    id: todoFixture.id,
    input: { completed: true },
  })
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith('Another task complete. Well done!'),
  )
})

it('marks a completed task as active and notifies', async () => {
  const user = userEvent.setup()
  const done = { ...todoFixture, completed: true }
  arrange({ todos: [done] })
  mutateAsync.mockResolvedValue({ ...done, completed: false })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /Toggle/ }))
  expect(mutateAsync).toHaveBeenCalledWith({
    id: done.id,
    input: { completed: false },
  })
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith('Task marked as active.'),
  )
})

it('does not notify when toggling fails', async () => {
  const user = userEvent.setup()
  arrange()
  mutateAsync.mockRejectedValue(new Error('fail'))
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /Toggle/ }))
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
  expect(notify).not.toHaveBeenCalled()
})

it('ignores toggles while busy', async () => {
  const user = userEvent.setup()
  arrange({ busy: true })
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /Toggle/ }))
  expect(mutateAsync).not.toHaveBeenCalled()
})

it('shows a mutation error in the alert, preferred over the query error', () => {
  arrange({
    mutationError: new Error('Update failed.'),
    queryError: new Error('Load failed.'),
  })
  render(<TodosPage />)
  expect(screen.getByTestId('alert')).toHaveTextContent('Update failed.')
})

it.each([
  ['fetching', { fetching: true }],
  ['busy', { busy: true }],
])('disables retry while %s', (_name, options) => {
  arrange({ queryError: new Error('Load failed.'), ...options })
  render(<TodosPage />)
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
})

it('shows no alert without errors', () => {
  arrange()
  render(<TodosPage />)
  expect(screen.queryByTestId('alert')).not.toBeInTheDocument()
})

it('passes filters, loading state and busy state to the children', () => {
  arrange({ pending: true, busy: true, todos: [] })
  render(<TodosPage />)
  expect(screen.getByText('Filters active/abc')).toBeVisible()
  expect(screen.getByText(/List loading=true/)).toHaveTextContent(
    'hasTodos=false busy=true count=0',
  )
  expect(screen.getByRole('button', { name: 'Header create' })).toBeDisabled()
  expect(screen.getByText('Notice: Hello')).toBeVisible()
})

it('enables creation once loaded and idle', () => {
  arrange()
  render(<TodosPage />)
  expect(screen.getByRole('button', { name: 'Header create' })).toBeEnabled()
})

it.each(['Header create', 'List create'])(
  'opens an empty editor from %s and closes it',
  async (name) => {
    const user = userEvent.setup()
    arrange()
    render(<TodosPage />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name }))
    expect(screen.getByText('Editing new')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  },
)

it('opens the editor for a task and closes it with a notice after saving', async () => {
  const user = userEvent.setup()
  arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /^Edit/ }))
  expect(screen.getByText(`Editing ${todoFixture.title}`)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Save editor' }))
  expect(notify).toHaveBeenCalledWith('Saved!')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('confirms deletion of the chosen task and notifies', async () => {
  const user = userEvent.setup()
  arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /^Delete/ }))
  expect(screen.getByText(`Deleting ${todoFixture.title}`)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
  expect(notify).toHaveBeenCalledWith('Task deleted.')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('closes the delete dialog without notifying when cancelled', async () => {
  const user = userEvent.setup()
  arrange()
  render(<TodosPage />)
  await user.click(screen.getByRole('button', { name: /^Delete/ }))
  await user.click(screen.getByRole('button', { name: 'Close delete' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(notify).not.toHaveBeenCalled()
})
