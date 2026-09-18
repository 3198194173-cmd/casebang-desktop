import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { loadConfig } from '../src/config.js'
import type { PrivateStorage } from '../src/storage.js'
import { registerWebOfficeRoutes } from '../src/weboffice.js'

const config = loadConfig({
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://casebang.tech/collab', DB_PASSWORD: 'test', STORAGE_ROOT: './tmp-test',
  WPS_WEBOFFICE_ENABLED: 'true', WPS_APP_ID: 'SX20260918QZNBYG', WPS_APP_SECRET: 'wps-test-secret'
})

function queryResult<T>(rows: T[]): pg.QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
}

describe('WPS WebOffice gateway', () => {
  it('issues a short-lived editor token only to a work item participant', async () => {
    const workItemId = '30000000-0000-4000-8000-000000000001'
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: '10000000-0000-4000-8000-000000000001', display_name: '建表人', avatar_url: null, organization_id: '20000000-0000-4000-8000-000000000001', corp_id: 'corp', business_role: 'upstream' }]))
      .mockResolvedValueOnce(queryResult([{ id: workItemId }]))
      .mockResolvedValueOnce(queryResult([]))
    const app = Fastify()
    registerWebOfficeRoutes(app, config, { query } as unknown as pg.Pool, {} as PrivateStorage)

    const response = await app.inject({
      method: 'POST', url: `/api/v1/collaboration/work-items/${workItemId}/weboffice-session`,
      headers: { authorization: `Bearer ${'x'.repeat(40)}` }
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ appId: 'SX20260918QZNBYG', fileId: 'f30000000000040008000000000000001', officeType: 's' })
    expect(response.json().fileToken.length).toBeGreaterThanOrEqual(32)
    expect(String(query.mock.calls[1]?.[0])).toContain('(origin_id=$3 OR assignee_id=$3)')
    await app.close()
  })

  it('returns the current private revision through a signed callback', async () => {
    const workItemId = '30000000-0000-4000-8000-000000000001'
    const fileId = 'f30000000000040008000000000000001'
    const token = 't'.repeat(40)
    const date = new Date().toUTCString()
    const contentMd5 = createHash('md5').update(`/weboffice/v3/3rd/files/${fileId}`).digest('hex')
    const signature = createHash('sha1').update(`${config.wps.appSecret}${contentMd5}${date}`).digest('hex')
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: '40000000-0000-4000-8000-000000000001', organization_id: '20000000-0000-4000-8000-000000000001', work_item_id: workItemId, user_id: '10000000-0000-4000-8000-000000000001', display_name: '建表人', avatar_url: null }]))
      .mockResolvedValueOnce(queryResult([{
        id: workItemId, organization_id: '20000000-0000-4000-8000-000000000001', title: '测试新建表.xlsx', revision: 2, version: 3,
        created_at: new Date('2026-09-18T00:00:00Z'), origin_id: '10000000-0000-4000-8000-000000000001', assignee_id: '10000000-0000-4000-8000-000000000002',
        object_key: 'org/item/revision-2.xlsx', sha256: 'a'.repeat(64), revision_created_at: new Date('2026-09-18T01:00:00Z'), modifier_id: '10000000-0000-4000-8000-000000000002'
      }]))
    const storage = { objectSize: vi.fn(async () => 12345) }
    const app = Fastify()
    registerWebOfficeRoutes(app, config, { query } as unknown as pg.Pool, storage as unknown as PrivateStorage)

    const response = await app.inject({
      method: 'GET', url: `/weboffice/v3/3rd/files/${fileId}`,
      headers: {
        'x-app-id': config.wps.appId, 'x-weboffice-token': token, date, 'content-md5': contentMd5,
        authorization: `WPS-2:${config.wps.appId}:${signature}`
      }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ code: 0, message: '', data: expect.objectContaining({ id: fileId, name: '测试新建表.xlsx', version: 2, size: 12345 }) })
    await app.close()
  })
})
