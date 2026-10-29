import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todosApi } from '../api/todos'
import { TodoStats } from './TodoStats'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../api/todos', () => ({ todosApi: { stats: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())

function renderStats() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TodoStats />
    </QueryClientProvider>,
  )
}

it('shows a loading status while statistics are pending', () => {
  vi.mocked(todosApi.stats).mockReturnValue(new Promise(() => {}))
  renderStats()
  expect(screen.getByRole('status')).toHaveTextContent('Loading statistics')
})

it('shows each count next to its label', async () => {
  vi.mocked(todosApi.stats).mockResolvedValue({
    total: 7,
    active: 5,
    completed: 2,
    overdue: 3,
  })
  renderStats()
  const card = await screen.findByLabelText('Task statistics')
  const cells = within(card)
    .getAllByRole('term')
    .map((term) => [term.textContent, term.nextElementSibling?.textContent])
  expect(cells).toEqual([
    ['Total', '7'],
    ['Active', '5'],
    ['Completed', '2'],
    ['Overdue', '3'],
  ])
})

it('shows zero counts', async () => {
  vi.mocked(todosApi.stats).mockResolvedValue({
    total: 0,
    active: 0,
    completed: 0,
    overdue: 0,
  })
  renderStats()
  const card = await screen.findByLabelText('Task statistics')
  expect(within(card).getAllByText('0')).toHaveLength(4)
})

it('renders nothing when statistics fail to load', async () => {
  vi.mocked(todosApi.stats).mockRejectedValue(new Error('down'))
  const { container } = renderStats()
  await waitFor(() => expect(todosApi.stats).toHaveBeenCalled())
  await waitFor(() => expect(container).toBeEmptyDOMElement())
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
