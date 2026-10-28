import { it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/core/lifespan.ts');
  process.exitCode = undefined;
});

it('starts the API on import', async () => {
  vi.resetModules();
  const start = vi.fn().mockResolvedValue({});
  vi.doMock('../src/core/lifespan.ts', () => ({ start }));
  await import('../src/main.ts');
  expect(start).toHaveBeenCalledOnce();
  expect(process.exitCode).toBeUndefined();
});
it('logs and sets a failing exit code when startup fails', async () => {
  vi.resetModules();
  const failure = new Error('boom');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.doMock('../src/core/lifespan.ts', () => ({ start: vi.fn().mockRejectedValue(failure) }));
  await import('../src/main.ts');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(error).toHaveBeenCalledWith('Cannot start Taskly App Node API:', failure);
});
