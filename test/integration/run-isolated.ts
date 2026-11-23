import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(__dirname, '../..');
const name = `thought-diary-integration-${randomUUID()}`;
const marker = randomBytes(24).toString('hex');
const password = randomBytes(32).toString('hex');
const user = `test_${randomBytes(8).toString('hex')}`;
const database = `integration_${randomBytes(8).toString('hex')}`;
const temp = mkdtempSync(join(tmpdir(), 'thought-diary-integration-'));
let id = '';
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    interrupted = true;
    console.error(
      `Interrupted; inspect container ${name} (${id || 'ID unavailable'}) before deliberate cleanup.`,
    );
  });

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = temp,
) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0 || result.error)
    throw new Error(`${command} failed (exit ${result.status ?? 'unknown'}).`);
  return result.stdout.trim();
}

const safeEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
};
try {
  if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production')
    throw new Error(
      'Unset DATABASE_URL and production NODE_ENV before running integration tests.',
    );
  id = run(
    'docker',
    [
      'create',
      '--name',
      name,
      '--label',
      `thought-diary.integration=${marker}`,
      '-e',
      'POSTGRES_USER',
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB',
      '-p',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      'postgres:16',
    ],
    {
      ...safeEnv,
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
    },
  );
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid container ID.');
  console.log(`Integration container: ${name} (${id})`);
  run('docker', ['start', id], safeEnv);
  const inspect = JSON.parse(run('docker', ['inspect', id], safeEnv)) as Array<{
    Id: string;
    Name: string;
    Config: { Labels: Record<string, string>; Env: string[] };
    NetworkSettings: {
      Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    };
  }>;
  const container = inspect[0];
  const ports = container?.NetworkSettings.Ports['5432/tcp'];
  if (
    container?.Id !== id ||
    container.Name !== `/${name}` ||
    container.Config.Labels['thought-diary.integration'] !== marker ||
    !container.Config.Env.includes(`POSTGRES_USER=${user}`) ||
    !container.Config.Env.includes(`POSTGRES_PASSWORD=${password}`) ||
    !container.Config.Env.includes(`POSTGRES_DB=${database}`) ||
    ports?.length !== 1 ||
    ports[0].HostIp !== '127.0.0.1' ||
    !/^\d+$/.test(ports[0].HostPort) ||
    ports[0].HostPort === '15434'
  )
    throw new Error('Container identity or endpoint verification failed.');
  const port = ports[0].HostPort;
  for (let attempt = 0; ; attempt++) {
    if (interrupted) throw new Error('Interrupted.');
    const ready = spawnSync(
      'docker',
      ['exec', id, 'pg_isready', '-U', user, '-d', database],
      { env: safeEnv, stdio: 'ignore' },
    );
    if (ready.status === 0) break;
    if (attempt >= 60) throw new Error('PostgreSQL did not become ready.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  const env = {
    ...safeEnv,
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public`,
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    INTEGRATION_MARKER: marker,
    INTEGRATION_CONTAINER_ID: id,
    INTEGRATION_CONTAINER_NAME: name,
    INTEGRATION_PORT: port,
    INTEGRATION_USER: user,
    INTEGRATION_PASSWORD: password,
    INTEGRATION_DATABASE: database,
  };
  run(
    process.execPath,
    [
      join(project, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      join(project, 'prisma.config.ts'),
    ],
    env,
  );
  if (interrupted) throw new Error('Interrupted.');
  const result = spawnSync(
    process.execPath,
    [
      join(project, 'node_modules/jest/bin/jest.js'),
      '--config',
      join(project, 'test/jest-integration.json'),
      '--runInBand',
    ],
    { cwd: temp, env, stdio: 'inherit' },
  );
  if (result.signal) interrupted = true;
  if (result.status !== 0) process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Integration runner failed.',
  );
  process.exitCode = 1;
} finally {
  if (/^[a-f0-9]{64}$/.test(id) && !interrupted) {
    const removed = spawnSync('docker', ['rm', '-f', id], {
      env: safeEnv,
      encoding: 'utf8',
    });
    if (removed.status === 0 && removed.stdout.trim() === id)
      console.log(`Removed integration container: ${name} (${id})`);
    else {
      console.error(`Container cleanup failed: ${name} (${id}).`);
      process.exitCode = 1;
    }
  } else if (id)
    console.error(`Container retained after interruption: ${name} (${id}).`);
  rmSync(temp, { recursive: true, force: true });
}
