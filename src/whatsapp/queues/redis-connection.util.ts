import type { ConnectionOptions } from 'bullmq';

export function buildRedisConnectionOptions(config: {
  host?: string;
  port?: number;
  password?: string;
}): ConnectionOptions {
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 6379,
    password: config.password,
    maxRetriesPerRequest: null,
  };
}
