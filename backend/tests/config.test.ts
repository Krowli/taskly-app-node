import { it, expect, vi, afterEach } from 'vitest';

afterEach(() => vi.unstubAllEnvs());
const parts = { POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_HOST: 'h', DB_PORT: '5433', POSTGRES_DB: 'my db' };
function stub(values: Record<string, string>) {
  for (const name of ['DATABASE_URL', ...Object.keys(parts)]) vi.stubEnv(name, values[name] ?? '');
}
async function load() {
  vi.resetModules();
  return (await import('../src/core/config.ts')).resolveDatabaseUrl;
}
it('prefers the override over DATABASE_URL', async () => {
  stub({ DATABASE_URL: 'postgresql://env/db' });
  expect((await load())('postgresql://override/db')).toBe('postgresql://override/db');
});
it('rewrites the psycopg scheme', async () => {
  stub({ DATABASE_URL: 'postgresql+psycopg://a/b' });
  expect((await load())()).toBe('postgresql://a/b');
});
it('builds the url from the parts', async () => {
  stub(parts);
  expect((await load())()).toBe('postgresql://u:p@h:5433/my%20db');
});
it.each(Object.keys(parts))('throws when %s is missing', async (name) => {
  stub({ ...parts, [name]: '' });
  expect((await load())).toThrow(`Missing environment variable: ${name}`);
});
