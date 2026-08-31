import { config } from 'dotenv';
import { DataSource } from 'typeorm';
// Load environment variables
config();

/**
 * TypeORM configuration for CLI operations (migrations, etc.)
 * This configuration is separate from the NestJS database config
 * and is used specifically for TypeORM CLI commands
 */
const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'dev',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'calling-bot',
  entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
  migrations: [`${__dirname}/../migrations/*{.ts,.js}`],
  synchronize: process.env.DB_SYNC === 'true',
  logging: process.env.DB_LOGGING === 'true',
  migrationsTableName: 'migrations',
  migrationsRun: false,
});

export default AppDataSource;
