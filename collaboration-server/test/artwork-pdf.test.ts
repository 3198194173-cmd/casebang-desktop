import Fastify from 'fastify'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { registerArtworkRoutes } from '../src/artwork.js'
import type { DingTalkDriveClient } from '../src/dingtalk-drive.js'
import type { DingTalkUserGrantStore } from '../src/dingtalk-user-grant.js'

const workItemId = '30000000-0000-4000-8000-000000000001'
const pdf = Buffer.from('%PDF-1.7\nartwork')

async function testServer() {
  const pool = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('UPDATE user_sessions')) return { rows: [{
      id: 'user-1', display_name: 'Tester', avatar_url: null, organization_id: 'org-1',
      corp_id: 'corp-1', business_role: 'downstream', dingtalk_union_id: 'union-1'
    }] }
    if (sql.includes('SELECT 1 FROM work_items')) return { rowCount: 1, rows: [{ '?column?': 1 }] }
    if (sql.includes('WITH RECURSIVE tree')) return { rows: params?.[3] === 'pdf-1' ? [{
      dentry_id: 'pdf-1', dentry_uuid: null, parent_id: 'folder-1', name: 'test.pdf',
      entry_type: 'FILE', extension: 'pdf', size_bytes: pdf.length, version: 3,
      path: null, modified_at: null, space_id: 'space-1'
    }] : [] }
    throw new Error(`Unexpected query: ${sql}`)
  }) } as unknown as pg.Pool
  const drive = {
    downloadPdfForUser: vi.fn(async () => pdf),
    pdfDownloadTicketForUser: vi.fn(async () => ({ url: 'https://example.aliyuncs.com/pdf?signature=temporary', headers: { 'x-signed': 'yes' } }))
  } as unknown as DingTalkDriveClient
  const grants = { accessToken: vi.fn(async () => 'token') } as unknown as DingTalkUserGrantStore
  const app = Fastify()
  registerArtworkRoutes(app, pool, drive, grants)
  return app
}

describe('artwork PDF transfer', () => {
  it('returns only a scoped, no-store signed ticket for desktop direct download', async () => {
    const app = await testServer()
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/dingtalk/artwork-targets/${workItemId}/pdfs/pdf-1/download-ticket`,
        headers: { authorization: `Bearer ${'x'.repeat(40)}` } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toEqual({ url: 'https://example.aliyuncs.com/pdf?signature=temporary', headers: { 'x-signed': 'yes' }, version: 3, sizeBytes: pdf.length })
    } finally { await app.close() }
  })

  it('does not issue a ticket for a PDF outside the bound work item', async () => {
    const app = await testServer()
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/dingtalk/artwork-targets/${workItemId}/pdfs/another-pdf/download-ticket`,
        headers: { authorization: `Bearer ${'x'.repeat(40)}` } })
      expect(response.statusCode).toBe(404)
    } finally { await app.close() }
  })
  it('sends PDF bytes instead of Base64 JSON to new desktop clients', async () => {
    const app = await testServer()
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/dingtalk/artwork-targets/${workItemId}/pdfs/pdf-1`,
        headers: { authorization: `Bearer ${'x'.repeat(40)}`, accept: 'application/pdf' } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/pdf')
      expect(response.headers['x-artwork-version']).toBe('3')
      expect(response.rawPayload).toEqual(pdf)
    } finally { await app.close() }
  })

  it('keeps the JSON response for older desktop clients', async () => {
    const app = await testServer()
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/dingtalk/artwork-targets/${workItemId}/pdfs/pdf-1`,
        headers: { authorization: `Bearer ${'x'.repeat(40)}` } })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, version: 3 })
    } finally { await app.close() }
  })
})
