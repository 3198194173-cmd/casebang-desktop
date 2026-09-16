import pg from 'pg'
import type { ServerConfig } from './config.js'

export function createDatabase(config: ServerConfig['database']): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'casebang-collaboration-server'
  })
}

export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1')
}
