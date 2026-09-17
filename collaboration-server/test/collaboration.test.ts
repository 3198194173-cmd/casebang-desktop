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

  it('requires a concrete reason before an assignee can return a task', async () => {
    const query = vi.fn().mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '处理人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp' }]))
    const pool = { query } as unknown as pg.Pool
    const app = Fastify()
    registerCollaborationRoutes(app, pool, {} as PrivateStorage)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/collaboration/work-items/30000000-0000-4000-8000-000000000001/actions',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json' },
      payload: {
        action: 'return-source', expectedVersion: 2, revision: 1,
        requestKey: '40000000-0000-4000-8000-000000000001'
      }
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'return_reason_required' })
    expect(query).toHaveBeenCalledOnce()
    await app.close()
  })

  it('lets only the assigned user claim the expected task version', async () => {
    const workItem = {
      id: '30000000-0000-4000-8000-000000000001', title: '待处理工作簿',
      state: 'PENDING_PROCESSING', source_workflow: 'manual', version: 1, revision: 1,
      created_at: new Date('2026-09-17T00:00:00Z'),
      origin_id: '10000000-0000-4000-8000-000000000001', origin_name: '建表人',
      assignee_id: '10000000-0000-4000-8000-000000000002', assignee_name: '处理人'
    }
    const updated = { ...workItem, state: 'PROCESSING', version: 2, last_action: 'claim', last_reason: null, last_event_at: new Date('2026-09-17T00:01:00Z') }
    const requestKey = '40000000-0000-4000-8000-000000000001'
    const clientQuery = vi.fn()
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([workItem]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
    const client = { query: clientQuery, release: vi.fn() }
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: workItem.assignee_id, display_name: '处理人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp' }]))
      .mockResolvedValueOnce(queryResult([updated]))
    const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool
    const app = Fastify()
    registerCollaborationRoutes(app, pool, {} as PrivateStorage)
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/collaboration/work-items/${workItem.id}/actions`,
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json' },
      payload: { action: 'claim', expectedVersion: 1, revision: 1, requestKey }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().item).toEqual(expect.objectContaining({ id: workItem.id, state: 'PROCESSING', version: 2, lastAction: 'claim' }))
    expect(clientQuery.mock.calls.some(call => String(call[0]).includes('UPDATE work_items SET state'))).toBe(true)
    expect(client.release).toHaveBeenCalledOnce()
    await app.close()
  })
})
