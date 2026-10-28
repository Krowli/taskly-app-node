import { it, expect, vi } from 'vitest';
import { createDatabase, initialize } from '../src/core/database.ts';
import type { Database } from '../src/features/todos/types.ts';

it('creates a client without connecting', async () => {
  const database = createDatabase('postgresql://u:p@localhost:5432/test');
  expect(typeof database.todo.findMany).toBe('function');
  await database.$disconnect();
});
it('creates the todos table when initializing', async () => {
  const executeRaw = vi.fn().mockResolvedValue(0);
  await initialize({ $executeRaw: executeRaw } as unknown as Database);
  expect(executeRaw).toHaveBeenCalledOnce();
  expect(executeRaw.mock.calls[0][0].join('')).toContain('CREATE TABLE IF NOT EXISTS todos');
});
