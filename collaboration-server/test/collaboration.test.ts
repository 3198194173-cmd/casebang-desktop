import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { registerCollaborationRoutes } from '../src/collaboration.js'
import type { PrivateStorage } from '../src/storage.js'

function queryResult<T>(rows: T[]): pg.QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
}

describe('collaboration identity boundaries', () => {
  it('lists only members returned for the authenticated organization and excludes the actor in SQL', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '卓志', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp' }]))
      .mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000002', display_name: '处理人', avatar_url: null, last_login_at: new Date('2026-09-17T00:00:00Z') }]))
    const pool = { query } as unknown as pg.Pool
    const app = Fastify()
    registerCollaborationRoutes(app, pool, {} as PrivateStorage)

    const response = await app.inject({ method: 'GET', url: '/api/v1/collaboration/members', headers: { authorization: `Bearer ${'x'.repeat(40)}` } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ members: [{ id: '10000000-0000-4000-8000-000000000002', displayName: '处理人', avatarUrl: null, lastLoginAt: '2026-09-17T00:00:00.000Z' }] })
    expect(query.mock.calls[1]?.[1]).toEqual(['20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'])
    await app.close()
  })

  it('rejects member and task access without a desktop session', async () => {
    const pool = { query: vi.fn() } as unknown as pg.Pool
    const app = Fastify()
    registerCollaborationRoutes(app, pool, {} as PrivateStorage)
    const response = await app.inject({ method: 'GET', url: '/api/v1/collaboration/work-items' })
    expect(response.statusCode).toBe(401)
    expect(pool.query).not.toHaveBeenCalled()
    await app.close()
  })

  it('accepts the workbook media type but requires bounded metadata before storage', async () => {
    const query = vi.fn().mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '卓志', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp' }]))
    const pool = { query } as unknown as pg.Pool
    const storage = { writeObject: vi.fn() } as unknown as PrivateStorage
    const app = Fastify()
    registerCollaborationRoutes(app, pool, storage)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/collaboration/work-items',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      payload: Buffer.from('workbook')
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'metadata_required' })
    expect(storage.writeObject).not.toHaveBeenCalled()
    await app.close()
  })
})
