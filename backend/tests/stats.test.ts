import express from 'express';
import request from 'supertest';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createDatabase } from '../src/core/database.ts';
import { TodoRepository } from '../src/features/todos/repository.ts';
import { createTodosRouter } from '../src/features/todos/router.ts';
import type { TodoStore } from '../src/features/todos/types.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setupRepository(counts: { total: number; completed: number; overdue: number }) {
  const database = createDatabase('******localhost:5432/test');
  const count = vi.spyOn(database.todo, 'count').mockImplementation(((args?: { where?: { completed?: boolean } }) => {
    if (!args) return Promise.resolve(counts.total);
    return Promise.resolve(args.where?.completed ? counts.completed : counts.overdue);
  }) as never);
  return { count, repository: new TodoRepository(database) };
}

describe('TodoRepository.stats', () => {
  it('derives active as total minus completed and passes overdue through', async () => {
    const { repository } = setupRepository({ total: 10, completed: 4, overdue: 2 });
    expect(await repository.stats()).toEqual({ total: 10, completed: 4, active: 6, overdue: 2 });
  });
  it('returns zeros for an empty table', async () => {
    const { repository } = setupRepository({ total: 0, completed: 0, overdue: 0 });
    expect(await repository.stats()).toEqual({ total: 0, completed: 0, active: 0, overdue: 0 });
  });
  it.each(['2026-03-31T00:00:00.000Z', '2026-03-31T23:59:59.999Z'])(
    'counts open tasks due before the start of today (UTC) as overdue at %s', async (now) => {
      vi.useFakeTimers({ now: new Date(now) });
      const { count, repository } = setupRepository({ total: 1, completed: 0, overdue: 1 });
      await repository.stats();
      expect(count).toHaveBeenCalledWith({ where: { completed: false, due_date: { lt: new Date('2026-03-31T00:00:00.000Z') } } });
      expect(count).toHaveBeenCalledWith({ where: { completed: true } });
    },
  );
  it('uses the new day boundary across a year change', async () => {
    vi.useFakeTimers({ now: new Date('2027-01-01T00:00:00.000Z') });
    const { count, repository } = setupRepository({ total: 0, completed: 0, overdue: 0 });
    await repository.stats();
    expect(count).toHaveBeenCalledWith({ where: { completed: false, due_date: { lt: new Date('2027-01-01T00:00:00.000Z') } } });
  });
});

describe('GET /api/todos/stats', () => {
  function setupApp() {
    const stats = { total: 5, completed: 2, active: 3, overdue: 1 };
    const repository = { list: vi.fn(), stats: vi.fn().mockResolvedValue(stats), create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() } as unknown as TodoStore;
    const app = express();
    app.use(express.json());
    app.use('/api/todos', createTodosRouter(repository));
    return { app, repository, stats };
  }
  it('returns the statistics from the repository', async () => {
    const { app, stats } = setupApp();
    const response = await request(app).get('/api/todos/stats');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(stats);
  });
  it('is not treated as a task id', async () => {
    const { app, repository } = setupApp();
    await request(app).get('/api/todos/stats');
    expect(repository.get).not.toHaveBeenCalled();
    expect(repository.stats).toHaveBeenCalledOnce();
  });
});
