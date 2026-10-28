import express from 'express';
import request from 'supertest';
import { it, expect, vi } from 'vitest';
import { createHealthRouter } from '../src/api/health.ts';
import type { Database } from '../src/features/todos/types.ts';

function setup(findFirst: ReturnType<typeof vi.fn>) {
  const database = { todo: { findFirst } } as unknown as Database;
  const app = express();
  app.use('/api', createHealthRouter(database));
  return { app, findFirst };
}
it('reports ok after querying the database', async () => {
  const { app, findFirst } = setup(vi.fn().mockResolvedValue(null));
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
});
it('fails when the database query rejects', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { app } = setup(vi.fn().mockRejectedValue(new Error('down')));
  expect((await request(app).get('/api/health')).status).toBe(500);
  vi.restoreAllMocks();
});
