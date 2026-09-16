import Fastify, { type FastifyInstance } from 'fastify'
import type { ServerConfig } from './config.js'

export interface Readiness {
  database(): Promise<void>
  storage(): Promise<void>
  stream: { enabled: boolean; connected: boolean }
}

export function buildServer(config: ServerConfig, readiness: Readiness): FastifyInstance {
  const app = Fastify({
    logger: config.environment === 'test' ? false : {
      level: config.environment === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.clientSecret', '*.password']
    },
    bodyLimit: 1024 * 1024
  })
  app.get('/health/live', async () => ({ ok: true, service: 'casebang-collaboration', version: '0.1.0' }))
  app.get('/health/ready', async (_request, reply) => {
    const checks = { database: false, storage: false, stream: !readiness.stream.enabled }
    const errors: string[] = []
    await Promise.all([
      readiness.database().then(() => { checks.database = true }).catch(() => errors.push('database')),
      readiness.storage().then(() => { checks.storage = true }).catch(() => errors.push('storage'))
    ])
    checks.stream = !readiness.stream.enabled || readiness.stream.connected
    if (!checks.stream) errors.push('dingtalk-stream')
    const ok = errors.length === 0
    return reply.code(ok ? 200 : 503).send({ ok, checks, unavailable: errors })
  })
  app.get('/api/v1/system/capabilities', async () => ({
    accountLogin: false,
    taskHandoff: false,
    formalNumberAllocation: false,
    dingtalkStream: readiness.stream.enabled ? (readiness.stream.connected ? 'connected' : 'connecting') : 'disabled',
    onlineMasterWrite: false,
    message: '中央服务基础已启动；未完成的能力不会显示为可用。'
  }))
  return app
}
