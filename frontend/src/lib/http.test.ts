import { afterEach, expect, it, vi } from 'vitest'
import { request } from './http'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn()
  if (response instanceof Error) fetchMock.mockRejectedValue(response)
  else fetchMock.mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status })

it('prefixes the path with /api and sends a JSON content type', async () => {
  const fetchMock = stubFetch(json([1], 200))
  await expect(request('/todos', { method: 'POST' })).resolves.toEqual([1])
  expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
})

it('lets callers override and extend headers', async () => {
  const fetchMock = stubFetch(json({}, 200))
  await request('/todos', { headers: { 'Content-Type': 'text/plain', X: '1' } })
  expect(fetchMock.mock.calls[0][1].headers).toEqual({
    'Content-Type': 'text/plain',
    X: '1',
  })
})

it('returns undefined for 204 responses', async () => {
  stubFetch(new Response(null, { status: 204 }))
  await expect(
    request('/todos/1', { method: 'DELETE' }),
  ).resolves.toBeUndefined()
})

it('reports a connection problem when fetch rejects', async () => {
  stubFetch(new TypeError('network'))
  await expect(request('/todos')).rejects.toThrow(
    'Cannot connect to the server. Please try again.',
  )
})

it('rethrows the original error when the request was aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' })
  stubFetch(abortError)
  await expect(request('/todos', { signal: controller.signal })).rejects.toBe(
    abortError,
  )
})

it('explains validation failures on 422', async () => {
  stubFetch(json({ detail: [{ msg: 'bad' }] }, 422))
  await expect(request('/todos')).rejects.toThrow(
    'Check the task details: title up to 120 characters, description up to 2000 characters, and a valid due date.',
  )
})

it('uses the string detail of an error response', async () => {
  stubFetch(json({ detail: 'Task not found.' }, 404))
  await expect(request('/todos/1')).rejects.toThrow('Task not found.')
})

it.each([
  ['a non-string detail', json({ detail: [1] }, 500)],
  ['an empty object', json({}, 500)],
  ['a body that is not JSON', new Response('oops', { status: 502 })],
  ['a null body', json(null, 500)],
])('falls back to a generic message for %s', async (_name, response) => {
  stubFetch(response)
  await expect(request('/todos')).rejects.toThrow(
    'The operation failed. Please try again.',
  )
})
