import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { TodoEmptyState } from './TodoEmptyState'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('invites the user to add a first task and forwards the click', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  render(
    <TodoEmptyState hasTodos={false} disabled={false} onCreate={onCreate} />,
  )
  expect(
    screen.getByRole('heading', { name: 'Add your first task' }),
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Add your first task' }))
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('disables the add button when disabled', () => {
  render(<TodoEmptyState hasTodos={false} disabled onCreate={vi.fn()} />)
  expect(
    screen.getByRole('button', { name: 'Add your first task' }),
  ).toBeDisabled()
})

it('explains that nothing matches when tasks exist', () => {
  render(<TodoEmptyState hasTodos disabled={false} onCreate={vi.fn()} />)
  expect(
    screen.getByRole('heading', { name: 'No matching tasks' }),
  ).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
