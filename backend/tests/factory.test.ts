import request from 'supertest';
import { it, expect, vi, afterEach } from 'vitest';
import { createApp } from '../src/factory.ts';
import type { Database } from '../src/features/todos/types.ts';
import { record } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());
function setup() {
  const findMany = vi.fn().mockResolvedValue([record]);
  const findFirst = vi.fn().mockResolvedValue(null);
  return createApp({ todo: { findMany, findFirst } } as unknown as Database);
}
it('mounts the health and todos routers', async () => {
  const app = setup();
  expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok' });
  const list = await request(app).get('/api/todos');
  expect(list.status).toBe(200);
  expect(list.body[0].id).toBe(record.id);
});
it('does not expose x-powered-by', async () => {
  expect((await request(setup()).get('/api/health')).headers['x-powered-by']).toBeUndefined();
});
it('serves the OpenAPI specification and docs', async () => {
  const app = setup();
  expect((await request(app).get('/openapi.json')).body.openapi).toBeDefined();
  expect((await request(app).get('/docs/').set('Accept', 'text/html')).status).toBe(200);
});
it('returns 404 json for unknown routes', async () => {
  const response = await request(setup()).get('/nope');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Not Found' });
});
it('returns 422 for malformed JSON', async () => {
  const response = await request(setup()).post('/api/todos').set('Content-Type', 'application/json').send('{bad');
  expect(response.status).toBe(422);
  expect(response.body).toEqual({ detail: 'Invalid JSON.' });
});
it('returns 413 for oversized bodies', async () => {
  const response = await request(setup()).post('/api/todos').send({ title: 'x'.repeat(200000) });
  expect(response.status).toBe(413);
  expect(response.body).toEqual({ detail: 'Request body too large.' });
});
it('returns 500 and logs when a handler fails', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const findMany = vi.fn().mockRejectedValue(new Error('boom'));
  const app = createApp({ todo: { findMany } } as unknown as Database);
  const response = await request(app).get('/api/todos');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ detail: 'Internal Server Error' });
  expect(error).toHaveBeenCalled();
});
