import { EventEmitter } from 'node:events';
import { it, expect, vi, beforeEach, afterEach } from 'vitest';

const database = { $connect: vi.fn(), $disconnect: vi.fn() };
const initialize = vi.fn();
const createApp = vi.fn();

vi.mock('../src/core/database.ts', () => ({ createDatabase: vi.fn(() => database), initialize }));
vi.mock('../src/core/config.ts', () => ({ resolveDatabaseUrl: () => 'postgresql://x/y' }));
vi.mock('../src/factory.ts', () => ({ createApp }));

class FakeServer extends EventEmitter {
  close = vi.fn((callback: () => void) => { callback(); });
  address = () => ({ port: 8123 });
}
let server: FakeServer;
let listen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('API_PORT', '');
  database.$connect.mockReset().mockResolvedValue(undefined);
  database.$disconnect.mockReset().mockResolvedValue(undefined);
  initialize.mockReset().mockResolvedValue(undefined);
  server = new FakeServer();
  listen = vi.fn((port: number, host: string, callback: () => void) => { queueMicrotask(callback); return server; });
  createApp.mockReset().mockReturnValue({ listen });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.exitCode = undefined;
});

async function startWithHooks() {
  const handlers: Record<string, () => void> = {};
  vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => { handlers[event] = handler; return process; }) as never);
  const { start } = await import('../src/core/lifespan.ts');
  return { result: await start(), handlers };
}

it('connects, initializes and listens on the default port', async () => {
  const { result } = await startWithHooks();
  expect(database.$connect).toHaveBeenCalledOnce();
  expect(initialize).toHaveBeenCalledWith(database);
  expect(listen).toHaveBeenCalledWith(8000, '0.0.0.0', expect.any(Function));
  expect(result.server).toBe(server);
  expect(console.log).toHaveBeenCalledWith('Taskly App Node API listening on port 8123');
});
it('listens on API_PORT when set', async () => {
  vi.stubEnv('API_PORT', '9001');
  await startWithHooks();
  expect(listen).toHaveBeenCalledWith(9001, '0.0.0.0', expect.any(Function));
});
it('disconnects and rethrows when connecting fails', async () => {
  const failure = new Error('no db');
  database.$connect.mockRejectedValue(failure);
  const { start } = await import('../src/core/lifespan.ts');
  await expect(start()).rejects.toBe(failure);
  expect(database.$disconnect).toHaveBeenCalledOnce();
  expect(listen).not.toHaveBeenCalled();
});
it('disconnects and rejects when the server emits an error', async () => {
  const failure = new Error('EADDRINUSE');
  listen.mockImplementation(() => { queueMicrotask(() => server.emit('error', failure)); return server; });
  const { start } = await import('../src/core/lifespan.ts');
  await expect(start()).rejects.toBe(failure);
  expect(database.$disconnect).toHaveBeenCalledOnce();
});
it.each(['SIGTERM', 'SIGINT'])('closes the server and disconnects on %s', async (signal) => {
  const { handlers } = await startWithHooks();
  handlers[signal]();
  await vi.waitFor(() => expect(database.$disconnect).toHaveBeenCalledOnce());
  expect(server.close).toHaveBeenCalledOnce();
  expect(process.exitCode).toBeUndefined();
});
it('sets a failing exit code when disconnecting fails during shutdown', async () => {
  const failure = new Error('disconnect');
  const { handlers } = await startWithHooks();
  database.$disconnect.mockRejectedValue(failure);
  handlers.SIGTERM();
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(console.error).toHaveBeenCalledWith(failure);
});
it('forces exit when the server does not close within 10 seconds', async () => {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const { handlers } = await startWithHooks();
  server.close.mockImplementation(() => {});
  handlers.SIGTERM();
  vi.advanceTimersByTime(9999);
  expect(exit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(exit).toHaveBeenCalledWith(1);
});
