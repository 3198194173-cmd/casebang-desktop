import { loadConfig } from './config.js'
import { checkDatabase, createDatabase } from './database.js'
import { runMigrations } from './migrations.js'
import { buildServer } from './server.js'
import { PrivateStorage } from './storage.js'
import { DingTalkStreamBridge } from './stream-bridge.js'
import { registerAuthRoutes } from './auth.js'
import { registerCollaborationRoutes } from './collaboration.js'
import { registerWebOfficeRoutes } from './weboffice.js'
import { registerArtworkRoutes } from './artwork.js'
import { DingTalkDriveClient } from './dingtalk-drive.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const pool = createDatabase(config.database)
  const storage = new PrivateStorage(config.storageRoot, config.cos.enabled ? config.cos : undefined)
  await storage.initialize()
  await runMigrations(pool, config.migrationsRoot)
  const stream = new DingTalkStreamBridge(config.dingtalk, pool, consoleLogger)
  await stream.start()
  const app = buildServer(config, {
    database: () => checkDatabase(pool),
    storage: () => storage.check(),
    stream
  })
  registerAuthRoutes(app, config, pool)
  registerCollaborationRoutes(app, pool, storage)
  registerWebOfficeRoutes(app, config, pool, storage)
  registerArtworkRoutes(app, pool, new DingTalkDriveClient(config))
  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '正在停止中央协同服务')
    stream.stop()
    await app.close()
    await pool.end()
  }
  process.once('SIGTERM', () => { void close('SIGTERM').finally(() => process.exit(0)) })
  process.once('SIGINT', () => { void close('SIGINT').finally(() => process.exit(0)) })
  await app.listen({ host: config.host, port: config.port })
}

const consoleLogger = {
  info: (value: object, message: string): void => console.info(message, value),
  warn: (value: object, message: string): void => console.warn(message, value),
  error: (value: object, message: string): void => console.error(message, value)
}

main().catch(error => {
  console.error('中央协同服务启动失败', formatStartupError(error))
  process.exitCode = 1
})

function formatStartupError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  if (!error || typeof error !== 'object') return String(error)

  const value = error as Record<string, unknown>
  const safeDetails = {
    statusCode: value.statusCode,
    code: value.code,
    message: value.message,
    error: value.error
  }
  try {
    return JSON.stringify(
      safeDetails,
      ['statusCode', 'code', 'message', 'error', 'Code', 'Message', 'Resource', 'RequestId', 'TraceId'],
      2
    )
  } catch {
    return Object.prototype.toString.call(error)
  }
}
