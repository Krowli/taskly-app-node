import express from 'express';
import request from 'supertest';
import { it, expect, vi } from 'vitest';
import type { Database } from '../src/features/todos/types.ts';

vi.mock('../src/features/todos/router.ts', () => ({
  createTodosRouter: () => {
    const router = express.Router();
    router.get('/', (req, res, next) => {
      res.write('partial');
      next(new Error('late failure'));
    });
    return router;
  },
}));

it('delegates errors to Express when the response already started', async () => {
  const { createApp } = await import('../src/factory.ts');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const app = createApp({} as unknown as Database);
  await expect(request(app).get('/api/todos')).rejects.toBeDefined();
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
