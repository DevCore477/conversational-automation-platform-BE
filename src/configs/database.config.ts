import { registerAs } from '@nestjs/config';
import { join } from 'path';

export default registerAs('database', () => ({
  type: 'postgres' as const,
  url: process.env.DATABASE_URL,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? process.env.DB_USERNAME,
  password: process.env.DB_PASS ?? process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'calling-bot',
  entities: [join(__dirname, '..', 'models', '**', '*.entity.{js,ts}')],
  ssl: process.env.DB_SSL === 'true',
  synchronize: process.env.DB_SYNC === 'true',
  logging: process.env.DB_LOGGING === 'true',
  poolMax: Number(process.env.DB_POOL_MAX ?? 30),
  poolIdleTimeoutMs: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 5000),
  /** Bound on establishing a NEW pool connection. Without this, `pg`'s default (0 = unbounded)
   *  means a connection attempt to a silently-unreachable host (network partition, firewall drop
   *  — as opposed to a cleanly refused port) hangs indefinitely, holding a pool slot forever;
   *  with `poolMax` connections each doing this during a real outage, the whole pool exhausts
   *  and every OTHER query in the app (including ones on the live call path that ARE awaited,
   *  e.g. agent/company lookups) queues behind it. Verified empirically: unbounded, a query
   *  against a silently-unreachable host was still pending after 5+ seconds. */
  connectionTimeoutMs: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5000),
}));
