import { createHash } from 'node:crypto'
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
      .mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '卓志', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream' }]))
      .mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000002', display_name: '处理人', avatar_url: null, last_login_at: new Date('2026-09-17T00:00:00Z') }]))
    const pool = { query } as unknown as pg.Pool
    const app = Fastify()
    registerCollaborationRoutes(app, pool, {} as PrivateStorage)

    const response = await app.inject({ method: 'GET', url: '/api/v1/collaboration/members', headers: { authorization: `Bearer ${'x'.repeat(40)}` } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ members: [{ id: '10000000-0000-4000-8000-000000000002', displayName: '处理人', avatarUrl: null, lastLoginAt: '2026-09-17T00:00:00.000Z' }] })
    expect(query.mock.calls[1]?.[1]).toEqual(['20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'])
    expect(String(query.mock.calls[1]?.[0])).not.toContain('business_role=')
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

  it('lists one shared workbook record for either project participant', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{
        id: '10000000-0000-4000-8000-000000000002', display_name: '处理人', avatar_url: null,
        organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'downstream'
      }]))
      .mockResolvedValueOnce(queryResult([]))
    const app = Fastify()
    registerCollaborationRoutes(app, { query } as unknown as pg.Pool, {} as PrivateStorage)

    const response = await app.inject({ method: 'GET', url: '/api/v1/collaboration/work-items', headers: { authorization: `Bearer ${'x'.repeat(40)}` } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [] })
    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[1]?.[0])).toContain('(w.origin_id=$2 OR w.assignee_id=$2)')
    await app.close()
  })

  it('accepts the workbook media type but requires bounded metadata before storage', async () => {
    const query = vi.fn().mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '卓志', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream' }]))
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

  it('saves an automated allocation as a new revision for either task participant', async () => {
    const workbook = Buffer.from('allocated workbook')
    const actorId = '10000000-0000-4000-8000-000000000001'
    const organizationId = '20000000-0000-4000-8000-000000000001'
    const workItemId = '30000000-0000-4000-8000-000000000001'
    const metadata = {
      sourceWorkflow: 'manual', sourceId: workItemId, title: '新建产品表.xlsx',
      sha256: createHash('sha256').update(workbook).digest('hex'), requestKey: '40000000-0000-4000-8000-000000000099',
      targetWorkItemId: workItemId, expectedVersion: 3, expectedRevision: 2
    }
    const current = {
      id: workItemId, title: metadata.title, state: 'PROCESSING', source_workflow: 'new-series', version: 3, revision: 2,
      created_at: new Date('2026-09-18T00:00:00Z'), origin_id: actorId, origin_name: '测试人',
      assignee_id: actorId, assignee_name: '测试人', current_sha256: 'a'.repeat(64)
    }
    const updated = { ...current, version: 4, revision: 3, modifier_id: actorId, modifier_name: '测试人', revision_created_at: new Date('2026-09-21T00:00:00Z') }
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: actorId, display_name: '测试人', avatar_url: null, organization_id: organizationId, corp_id: 'corp', business_role: 'downstream' }]))
      .mockResolvedValueOnce(queryResult([updated]))
    const clientQuery = vi.fn(async (sql: string) => String(sql).includes('FOR UPDATE OF w') ? queryResult([current]) : queryResult([]))
    const storage = { writeObject: vi.fn(), removeObject: vi.fn() }
    const app = Fastify()
    registerCollaborationRoutes(app, {
      query, connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() }))
    } as unknown as pg.Pool, storage as unknown as PrivateStorage)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/collaboration/work-items',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-casebang-metadata': Buffer.from(JSON.stringify(metadata)).toString('base64url') },
      payload: workbook
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ item: expect.objectContaining({ id: workItemId, version: 4, revision: 3, lastEditor: { id: actorId, displayName: '测试人' } }), duplicate: false })
    expect(storage.writeObject).toHaveBeenCalledWith(`${organizationId}/${workItemId}/revision-3.xlsx`, workbook, metadata.sha256)
    expect(clientQuery.mock.calls.some(call => String(call[0]).includes("'save-workbook'"))).toBe(true)
    await app.close()
  })

  it('lets one account create and own a shared workbook without a downstream account', async () => {
    const workbook = Buffer.from('workbook')
    const originId = '10000000-0000-4000-8000-000000000001'
    const metadata = {
      sourceWorkflow: 'new-series', sourceId: 'source-1', title: '新建产品表.xlsx',
      sha256: createHash('sha256').update(workbook).digest('hex'), requestKey: '40000000-0000-4000-8000-000000000001'
    }
    const stored = {
      id: '30000000-0000-4000-8000-000000000001', title: metadata.title,
      state: 'PENDING_PROCESSING', source_workflow: metadata.sourceWorkflow, version: 1, revision: 1,
      created_at: new Date('2026-09-18T00:00:00Z'), origin_id: originId, origin_name: '建表人',
      assignee_id: originId, assignee_name: '建表人'
    }
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: originId, display_name: '建表人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream' }]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([stored]))
    const clientQuery = vi.fn().mockResolvedValue(queryResult([]))
    const app = Fastify()
    registerCollaborationRoutes(app, {
      query, connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() }))
    } as unknown as pg.Pool, { writeObject: vi.fn(), removeObject: vi.fn() } as unknown as PrivateStorage)
    const response = await app.inject({
      method: 'POST', url: '/api/v1/collaboration/work-items',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-casebang-metadata': Buffer.from(JSON.stringify(metadata)).toString('base64url') },
      payload: workbook
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ item: expect.objectContaining({
      origin: { id: originId, displayName: '建表人' },
      assignee: { id: originId, displayName: '建表人' },
      lastEditor: { id: originId, displayName: '建表人' }
    }), duplicate: false })
    const insertWorkItem = clientQuery.mock.calls.find(call => String(call[0]).includes('INSERT INTO work_items'))
    expect(insertWorkItem?.[1]?.[2]).toBe(originId)
    expect(insertWorkItem?.[1]?.[3]).toBe(originId)
    expect(clientQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO outbox_events'))).toBe(false)
    await app.close()
  })

  it('prepares a chunked upload without requiring a downstream account', async () => {
    const workbook = Buffer.from('workbook')
    const actor = {
      id: '10000000-0000-4000-8000-000000000001', display_name: '建表人', avatar_url: null,
      organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream'
    }
    const query = vi.fn().mockResolvedValueOnce(queryResult([actor]))
    const storage = { writeObject: vi.fn() }
    const app = Fastify()
    registerCollaborationRoutes(app, { query } as unknown as pg.Pool, storage as unknown as PrivateStorage)

    const response = await app.inject({
      method: 'POST', url: '/api/v1/collaboration/workbook-uploads',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json' },
      payload: {
        sourceWorkflow: 'new-series', sourceId: 'source-preflight', title: '预检工作簿.xlsx', size: workbook.length,
        sha256: createHash('sha256').update(workbook).digest('hex'), requestKey: '40000000-0000-4000-8000-000000000004'
      }
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual(expect.objectContaining({ uploadId: expect.any(String), totalChunks: 1 }))
    expect(storage.writeObject).toHaveBeenCalledOnce()
    await app.close()
  })

  it('returns a short-lived direct COS upload target when object storage is enabled', async () => {
    const workbook = Buffer.from('workbook')
    const actor = {
      id: '10000000-0000-4000-8000-000000000001', display_name: '建表人', avatar_url: null,
      organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream'
    }
    const query = vi.fn().mockResolvedValueOnce(queryResult([actor]))
    const storage = {
      supportsDirectTransfer: true,
      writeObject: vi.fn(),
      createUploadUrl: vi.fn(() => 'https://casebang-workbooks.cos.ap-guangzhou.myqcloud.com/signed')
    }
    const app = Fastify()
    registerCollaborationRoutes(app, { query } as unknown as pg.Pool, storage as unknown as PrivateStorage)

    const sha256 = createHash('sha256').update(workbook).digest('hex')
    const response = await app.inject({
      method: 'POST', url: '/api/v1/collaboration/workbook-uploads',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json' },
      payload: {
        sourceWorkflow: 'new-series', sourceId: 'source-direct', title: 'COS工作簿.xlsx', size: workbook.length,
        sha256, requestKey: '40000000-0000-4000-8000-000000000005'
      }
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual(expect.objectContaining({
      uploadId: expect.any(String), uploadMode: 'direct',
      uploadUrl: 'https://casebang-workbooks.cos.ap-guangzhou.myqcloud.com/signed',
      headers: expect.objectContaining({ 'x-cos-meta-sha256': sha256 })
    }))
    expect(storage.createUploadUrl).toHaveBeenCalledWith(expect.stringMatching(/workbook\.xlsx$/))
    await app.close()
  })

  it('stores the exported workbook and automatically links the downstream account', async () => {
    const workbook = Buffer.from('generated workbook')
    const originId = '10000000-0000-4000-8000-000000000001'
    const assigneeId = '10000000-0000-4000-8000-000000000002'
    const metadata = {
      sourceWorkflow: 'new-products', sourceId: 'source-2', title: '系列补产品.xlsx',
      sha256: createHash('sha256').update(workbook).digest('hex'), requestKey: '40000000-0000-4000-8000-000000000002'
    }
    const stored = {
      id: '30000000-0000-4000-8000-000000000001', title: metadata.title,
      state: 'PENDING_PROCESSING', source_workflow: metadata.sourceWorkflow, version: 1, revision: 1,
      created_at: new Date('2026-09-17T00:00:00Z'), origin_id: originId, origin_name: '建表人',
      assignee_id: assigneeId, assignee_name: '加工人'
    }
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: originId, display_name: '建表人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream' }]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([{ id: assigneeId }]))
      .mockResolvedValueOnce(queryResult([stored]))
    const clientQuery = vi.fn().mockResolvedValue(queryResult([]))
    const client = { query: clientQuery, release: vi.fn() }
    const storage = { writeObject: vi.fn() }
    const app = Fastify()
    registerCollaborationRoutes(app, { query, connect: vi.fn(async () => client) } as unknown as pg.Pool, storage as unknown as PrivateStorage)

    const response = await app.inject({
      method: 'POST', url: '/api/v1/collaboration/work-items',
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-casebang-metadata': Buffer.from(JSON.stringify(metadata)).toString('base64url') },
      payload: workbook
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ item: expect.objectContaining({ title: metadata.title, state: 'PENDING_PROCESSING', revision: 1 }), duplicate: false })
    expect(storage.writeObject).toHaveBeenCalledWith(expect.stringMatching(/revision-1\.xlsx$/), workbook, metadata.sha256)
    const insertWorkItem = clientQuery.mock.calls.find(call => String(call[0]).includes('INSERT INTO work_items'))
    expect(insertWorkItem?.[1]?.[3]).toBe(assigneeId)
    const outbox = clientQuery.mock.calls.find(call => String(call[0]).includes('INSERT INTO outbox_events'))
    expect(outbox?.[1]?.[4]).toEqual(expect.objectContaining({ type: 'workbook-published', state: 'PENDING_PROCESSING' }))
    await app.close()
  })

  it('accepts a workbook in bounded chunks and finalizes the same verified submission', async () => {
    const workbook = Buffer.from('chunked generated workbook')
    const originId = '10000000-0000-4000-8000-000000000001'
    const assigneeId = '10000000-0000-4000-8000-000000000002'
    const organizationId = '20000000-0000-4000-8000-000000000001'
    const actor = { id: originId, display_name: '建表人', avatar_url: null, organization_id: organizationId, corp_id: 'corp', business_role: 'upstream' }
    const metadata = {
      sourceWorkflow: 'new-series', sourceId: 'source-chunked', title: '分块工作簿.xlsx',
      sha256: createHash('sha256').update(workbook).digest('hex'), requestKey: '40000000-0000-4000-8000-000000000003',
      size: workbook.length
    }
    const stored = {
      id: '30000000-0000-4000-8000-000000000003', title: metadata.title,
      state: 'PENDING_PROCESSING', source_workflow: metadata.sourceWorkflow, version: 1, revision: 1,
      created_at: new Date('2026-09-18T00:00:00Z'), origin_id: originId, origin_name: '建表人',
      assignee_id: assigneeId, assignee_name: '加工人'
    }
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([actor]))
      .mockResolvedValueOnce(queryResult([actor]))
      .mockResolvedValueOnce(queryResult([actor]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([{ id: assigneeId }]))
      .mockResolvedValueOnce(queryResult([stored]))
    const clientQuery = vi.fn().mockResolvedValue(queryResult([]))
    const objects = new Map<string, Buffer>()
    const storage = {
      writeObject: vi.fn(async (key: string, value: Buffer) => { objects.set(key, Buffer.from(value)) }),
      readObject: vi.fn(async (key: string) => {
        const value = objects.get(key)
        if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return Buffer.from(value)
      }),
      removeObject: vi.fn(async (key: string) => { objects.delete(key) }),
      removeTree: vi.fn(async (prefix: string) => {
        for (const key of objects.keys()) if (key === prefix || key.startsWith(`${prefix}/`)) objects.delete(key)
      })
    }
    const app = Fastify()
    registerCollaborationRoutes(app, {
      query,
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() }))
    } as unknown as pg.Pool, storage as unknown as PrivateStorage)
    const authorization = `Bearer ${'x'.repeat(40)}`

    const prepared = await app.inject({
      method: 'POST', url: '/api/v1/collaboration/workbook-uploads',
      headers: { authorization, 'content-type': 'application/json' }, payload: metadata
    })
    expect(prepared.statusCode).toBe(201)
    const upload = prepared.json() as { uploadId: string; totalChunks: number }
    expect(upload.totalChunks).toBe(1)

    const chunk = await app.inject({
      method: 'POST', url: `/api/v1/collaboration/workbook-uploads/${upload.uploadId}/chunks/0`,
      headers: { authorization, 'content-type': 'application/json' }, payload: { data: workbook.toString('base64') }
    })
    expect(chunk.statusCode).toBe(204)

    const completed = await app.inject({
      method: 'POST', url: `/api/v1/collaboration/workbook-uploads/${upload.uploadId}/complete`, headers: { authorization }
    })
    expect(completed.statusCode).toBe(201)
    expect(completed.json()).toEqual({ item: expect.objectContaining({ id: stored.id, revision: 1 }), duplicate: false })
    expect(storage.removeTree).toHaveBeenCalled()
    expect(storage.writeObject).toHaveBeenCalledWith(expect.stringMatching(/revision-1\.xlsx$/), workbook, metadata.sha256)
    await app.close()
  })

  it('requires a concrete reason before an assignee can return a task', async () => {
    const query = vi.fn().mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '处理人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'downstream' }]))
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
      .mockResolvedValueOnce(queryResult([{ id: workItem.assignee_id, display_name: '处理人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'downstream' }]))
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

  it('lets either participant update the shared stage and queues one notification for the other participant', async () => {
    const workItem = {
      id: '30000000-0000-4000-8000-000000000001', title: '共享工作簿',
      state: 'PROCESSING', source_workflow: 'manual', version: 2, revision: 1,
      created_at: new Date('2026-09-17T00:00:00Z'),
      origin_id: '10000000-0000-4000-8000-000000000001', origin_name: '建表人',
      assignee_id: '10000000-0000-4000-8000-000000000002', assignee_name: '加工人'
    }
    const updated = { ...workItem, state: 'PENDING_ORIGIN_REVIEW', version: 3, last_action: 'update-stage', last_reason: null, last_event_at: new Date('2026-09-17T00:01:00Z') }
    const clientQuery = vi.fn()
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([workItem]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
    const client = { query: clientQuery, release: vi.fn() }
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: workItem.origin_id, display_name: '建表人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream' }]))
      .mockResolvedValueOnce(queryResult([updated]))
    const app = Fastify()
    registerCollaborationRoutes(app, { query, connect: vi.fn(async () => client) } as unknown as pg.Pool, {} as PrivateStorage)

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/collaboration/work-items/${workItem.id}/actions`,
      headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json' },
      payload: { action: 'update-stage', state: 'PENDING_ORIGIN_REVIEW', expectedVersion: 2, revision: 1, requestKey: '40000000-0000-4000-8000-000000000002' }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().item).toEqual(expect.objectContaining({ state: 'PENDING_ORIGIN_REVIEW', version: 3 }))
    const outboxCall = clientQuery.mock.calls.find(call => String(call[0]).includes('INSERT INTO outbox_events'))
    expect(outboxCall?.[1]?.[3]).toBe(workItem.assignee_id)
    expect(outboxCall?.[1]?.[4]).toEqual(expect.objectContaining({ type: 'work-item-stage-updated', state: 'PENDING_ORIGIN_REVIEW' }))
    await app.close()
  })
})
