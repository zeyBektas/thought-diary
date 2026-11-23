import { execFileSync } from 'node:child_process';

const {
  INTEGRATION_MARKER: marker,
  INTEGRATION_CONTAINER_ID: id,
  INTEGRATION_CONTAINER_NAME: name,
  INTEGRATION_PORT: port,
  INTEGRATION_USER: user,
  INTEGRATION_PASSWORD: password,
  INTEGRATION_DATABASE: database,
  DATABASE_URL: url,
} = process.env;
if (
  process.env.NODE_ENV !== 'test' ||
  !marker?.match(/^[a-f0-9]{48}$/) ||
  !id?.match(/^[a-f0-9]{64}$/) ||
  !name?.match(/^thought-diary-integration-[a-f0-9-]{36}$/) ||
  !port?.match(/^\d+$/) ||
  port === '15434' ||
  !user?.match(/^test_[a-f0-9]{16}$/) ||
  !password?.match(/^[a-f0-9]{64}$/) ||
  !database?.match(/^integration_[a-f0-9]{16}$/) ||
  url !==
    `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public`
)
  throw new Error('Unsafe integration database configuration.');
const inspected = JSON.parse(
  execFileSync('docker', ['inspect', id], { encoding: 'utf8' }),
) as Array<{
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string>; Env: string[] };
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
}>;
const c = inspected[0];
const ports = c?.NetworkSettings.Ports['5432/tcp'];
if (
  c?.Id !== id ||
  c.Name !== `/${name}` ||
  c.Config.Labels['thought-diary.integration'] !== marker ||
  !c.Config.Env.includes(`POSTGRES_USER=${user}`) ||
  !c.Config.Env.includes(`POSTGRES_PASSWORD=${password}`) ||
  !c.Config.Env.includes(`POSTGRES_DB=${database}`) ||
  ports?.length !== 1 ||
  ports[0].HostIp !== '127.0.0.1' ||
  ports[0].HostPort !== port
)
  throw new Error('Integration container verification failed.');
