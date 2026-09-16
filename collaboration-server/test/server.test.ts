import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'

const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3100', DB_PASSWORD: 'test', STORAGE_ROOT: './tmp-test' })

describe('central service health contract', () => {
  it('reports liveness without exposing credentials', async () => {
    const app = buildServer(config, { database: async () => undefined, storage: async () => undefined, stream: { enabled: false, connected: false } })
    const result = await app.inject({ method: 'GET', url: '/health/live' })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ ok: true, service: 'casebang-collaboration' })
    expect(result.body).not.toContain('test')
    await app.close()
  })
  it('fails readiness when the database or enabled Stream is unavailable', async () => {
    const app = buildServer(config, {
      database: async () => { throw new Error('password must not leak') },
      storage: async () => undefined,
      stream: { enabled: true, connected: false }
    })
    const result = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(result.statusCode).toBe(503)
    expect(result.json()).toEqual({ ok: false, checks: { database: false, storage: true, stream: false }, unavailable: ['database', 'dingtalk-stream'] })
    expect(result.body).not.toContain('password')
    await app.close()
  })
  it('does not claim unfinished capabilities are available', async () => {
    const app = buildServer(config, { database: async () => undefined, storage: async () => undefined, stream: { enabled: false, connected: false } })
    const result = await app.inject({ method: 'GET', url: '/api/v1/system/capabilities' })
    expect(result.json()).toMatchObject({ accountLogin: false, taskHandoff: false, formalNumberAllocation: false, onlineMasterWrite: false, dingtalkStream: 'disabled' })
    await app.close()
  })
})
