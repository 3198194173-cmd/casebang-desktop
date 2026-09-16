import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'

const lockName = 'casebang-collaboration-schema-migrations'

export async function runMigrations(pool: pg.Pool, migrationsRoot: string): Promise<void> {
  const names = (await readdir(migrationsRoot)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort()
  if (!names.length) throw new Error('没有找到数据库迁移文件')
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    for (const name of names) {
      const sql = await readFile(join(migrationsRoot, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const prior = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name])
      if (prior.rowCount) {
        if (prior.rows[0]?.checksum !== checksum) throw new Error(`已应用的迁移 ${name} 内容发生变化，已停止启动`)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => undefined)
    client.release()
  }
}
