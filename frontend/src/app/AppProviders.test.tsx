import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { GlobalStyles } from '../design-system'
import { queryClient } from '../lib/queryClient'
import { AppProviders } from './AppProviders'

vi.mock('../design-system', () => import('../design-system/mocks'))

function ClientProbe({ onClient }: { onClient: (c: QueryClient) => void }) {
  onClient(useQueryClient())
  return <p>child</p>
}

it('renders children with global styles and the shared client by default', () => {
  const onClient = vi.fn()
  render(
    <AppProviders>
      <ClientProbe onClient={onClient} />
    </AppProviders>,
  )
  expect(screen.getByText('child')).toBeVisible()
  expect(GlobalStyles).toHaveBeenCalled()
  expect(onClient).toHaveBeenCalledWith(queryClient)
})

it('uses a provided client', () => {
  const custom = new QueryClient()
  const onClient = vi.fn()
  render(
    <AppProviders client={custom}>
      <ClientProbe onClient={onClient} />
    </AppProviders>,
  )
  expect(onClient).toHaveBeenCalledWith(custom)
})
