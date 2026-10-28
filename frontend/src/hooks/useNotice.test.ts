import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { afterEach, describe, vi } from 'vitest'
import { useNotice } from './useNotice'

it('starts without a notice and exposes a notification callback', () => {
  const { result } = renderHook(() => useNotice())
  expect(result.current.message).toBe('')
  expect(result.current.notify).toEqual(expect.any(Function))
})

describe('notice lifetime', () => {
  afterEach(() => vi.useRealTimers())

  it('shows a notice and clears it after 4 seconds', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNotice())
    act(() => result.current.notify('Saved.'))
    expect(result.current.message).toBe('Saved.')
    act(() => vi.advanceTimersByTime(3999))
    expect(result.current.message).toBe('Saved.')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.message).toBe('')
  })

  it('restarts the timer when a new notice replaces the current one', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNotice())
    act(() => result.current.notify('First'))
    act(() => vi.advanceTimersByTime(3000))
    act(() => result.current.notify('Second'))
    act(() => vi.advanceTimersByTime(3999))
    expect(result.current.message).toBe('Second')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.message).toBe('')
  })

  it('keeps the same notify callback across renders', () => {
    const { result, rerender } = renderHook(() => useNotice())
    const first = result.current.notify
    rerender()
    expect(result.current.notify).toBe(first)
  })
})
