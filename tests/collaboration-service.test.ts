import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directFetch = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\CasebangTest') },
  net: { fetch: vi.fn() },
  session: { fromPartition: vi.fn(() => ({ fetch: directFetch })) },
  shell: { openPath: vi.fn(async () => ''), openExternal: vi.fn(async () => undefined) }
}))

import { net, session as electronSession, shell } from 'electron'
import { CollaborationService } from '../src/main/modules/collaboration/collaboration-service'
import type { SettingsRepository } from '../src/main/infrastructure/settings-repository'

const session = {
  sessionToken: 'session-token-for-tests',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  user: { id: 'user-1', displayName: '卓志', avatarUrl: null, organizationId: 'org-1', corpId: 'corp-1', businessRole: 'upstream' as const }
}

function settings() {
  return {
    getCollaborationSession: vi.fn(async () => session),
    clearCollaborationSession: vi.fn(async () => undefined)
  } as unknown as SettingsRepository
}

describe('desktop collaboration service', () => {
  beforeEach(() => { vi.mocked(net.fetch).mockReset(); directFetch.mockReset() })

  it('uses the encrypted login session for the same-organization member directory', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ members: [{ id: 'user-2', displayName: '处理人', avatarUrl: null, lastLoginAt: '2026-09-17T00:00:00.000Z' }] }), { status: 200 }))
    const value = settings()
    const result = await new CollaborationService(value).members()

    expect(result).toHaveLength(1)
    expect(net.fetch).toHaveBeenCalledWith(expect.stringContaining('/collaboration/members'), expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${session.sessionToken}` })
    }))
  })

  it('clears a rejected global login session', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'session_expired' }), { status: 401 }))
    const value = settings()
    await expect(new CollaborationService(value).workItems()).rejects.toThrow('登录已失效')
    expect(value.clearCollaborationSession).toHaveBeenCalledOnce()
  })

  it('loads the organization shared material master and normalizes an older response without activities', async () => {
    const item = { id: '30000000-0000-4000-8000-000000000001', title: '物料总表.xlsx', state: 'PENDING_PROCESSING', sourceWorkflow: 'manual', version: 1, revision: 3, createdAt: '2026-09-21T00:00:00.000Z', origin: { id: 'user-1', displayName: '卓志' }, assignee: { id: 'user-1', displayName: '卓志' }, lastEditor: { id: 'user-1', displayName: '卓志' }, lastEditedAt: '2026-09-21T01:00:00.000Z' }
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ item }), { status: 200 }))
    await expect(new CollaborationService(settings()).materialMaster()).resolves.toMatchObject({ id: item.id, revision: 3, activities: [] })
    expect(net.fetch).toHaveBeenCalledWith(expect.stringContaining('/collaboration/material-master'), expect.any(Object))
  })

  it('updates the shared workbook stage without an inbox or outbox parameter', async () => {
    const item = { id: '30000000-0000-4000-8000-000000000001', title: '测试工作簿', state: 'PENDING_ORIGIN_REVIEW', sourceWorkflow: 'manual', version: 3, revision: 1, createdAt: '2026-09-17T00:00:00.000Z', origin: { id: 'user-1', displayName: '建表人' }, assignee: { id: 'user-2', displayName: '处理人' } }
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ item, duplicate: false }), { status: 200 }))
    const result = await new CollaborationService(settings()).act({
      workItemId: item.id, action: 'update-stage', state: 'PENDING_ORIGIN_REVIEW', expectedVersion: 2, revision: 1
    })

    expect(result.item.state).toBe('PENDING_ORIGIN_REVIEW')
    const request = vi.mocked(net.fetch).mock.calls[0]
    expect(JSON.parse(String(request?.[1]?.body))).toEqual(expect.objectContaining({ action: 'update-stage', state: 'PENDING_ORIGIN_REVIEW' }))
  })

  it('publishes an exported workbook without asking the user to choose a recipient', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-publish-'))
    const workbookPath = join(directory, '新建产品表.xlsx')
    const workbook = Buffer.alloc(64 * 1024 + 11, 7)
    await writeFile(workbookPath, workbook)
    const item = { id: '30000000-0000-4000-8000-000000000001', title: '新建产品表.xlsx', state: 'PENDING_PROCESSING', sourceWorkflow: 'new-series', version: 1, revision: 1, createdAt: '2026-09-17T00:00:00.000Z', origin: { id: 'user-1', displayName: '建表人' }, assignee: { id: 'user-2', displayName: '加工人' } }
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploadId: '40000000-0000-4000-8000-000000000001', chunkSize: 64 * 1024, totalChunks: 2 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ item, duplicate: false }), { status: 201 }))
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const result = await new CollaborationService(settings()).publishWorkbook({ path: workbookPath, title: '新建产品表.xlsx', sourceWorkflow: 'new-series' })
      expect(result.item.state).toBe('PENDING_PROCESSING')
      expect(timeout).toHaveBeenCalledWith(90_000)
      expect(net.fetch).toHaveBeenCalledTimes(4)
      const prepareRequest = vi.mocked(net.fetch).mock.calls[0]
      const metadata = JSON.parse(String(prepareRequest?.[1]?.body))
      expect(metadata).toEqual(expect.objectContaining({ sourceWorkflow: 'new-series', title: '新建产品表.xlsx', size: workbook.length }))
      expect(metadata).not.toHaveProperty('assigneeId')
      expect(vi.mocked(net.fetch).mock.calls[1]?.[0]).toContain('/chunks/0')
      expect(vi.mocked(net.fetch).mock.calls[1]?.[1]).toEqual(expect.objectContaining({
        method: 'POST', headers: expect.objectContaining({ 'content-type': 'application/json' })
      }))
      expect(Buffer.from(JSON.parse(String(vi.mocked(net.fetch).mock.calls[1]?.[1]?.body)).data, 'base64')).toEqual(workbook.subarray(0, 64 * 1024))
      expect(vi.mocked(net.fetch).mock.calls[2]?.[0]).toContain('/chunks/1')
      expect(vi.mocked(net.fetch).mock.calls[3]?.[0]).toContain('/complete')
    } finally {
      timeout.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('submits an assignee action with optimistic task version fields', async () => {
    const item = { id: '30000000-0000-4000-8000-000000000001', title: '测试工作簿', state: 'PROCESSING', sourceWorkflow: 'manual', version: 2, revision: 1, createdAt: '2026-09-17T00:00:00.000Z', origin: { id: 'user-1', displayName: '建表人' }, assignee: { id: 'user-2', displayName: '处理人' } }
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ item, duplicate: false }), { status: 200 }))
    const result = await new CollaborationService(settings()).act({
      workItemId: item.id, action: 'claim', expectedVersion: 1, revision: 1
    })

    expect(result.item.state).toBe('PROCESSING')
    const request = vi.mocked(net.fetch).mock.calls[0]
    expect(request?.[0]).toContain(`/work-items/${item.id}/actions`)
    expect(JSON.parse(String(request?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'claim', expectedVersion: 1, revision: 1
    }))
  })

  it('opens only the verified CASEBANG WebOffice editor address', async () => {
    const workItemId = '30000000-0000-4000-8000-000000000001'
    const editorUrl = `https://collab.casebang.tech/weboffice/editor?fileId=f30000000000040008000000000000001#token=test`
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ editorUrl }), { status: 201 }))
    await new CollaborationService(settings()).openOnlineWorkbook({ workItemId })
    expect(net.fetch).toHaveBeenCalledWith(expect.stringContaining(`/work-items/${workItemId}/weboffice-session`), expect.objectContaining({ method: 'POST' }))
    expect(shell.openExternal).toHaveBeenCalledWith(editorUrl)
  })

  it('downloads the signed PDF directly in a non-persistent uncached desktop session', async () => {
    const pdf = Buffer.from('%PDF-1.7\nartwork')
    const signedUrl = 'https://example.oss-cn-hangzhou.aliyuncs.com/file?signature=temporary'
    vi.mocked(net.fetch).mockResolvedValue(Response.json({ url: signedUrl, headers: { 'x-signed': 'yes' }, version: 3, sizeBytes: pdf.length }))
    directFetch.mockResolvedValue(new Response(pdf, { status: 200 }))
    const result = await new CollaborationService(settings()).artworkPdf({
      workItemId: '30000000-0000-4000-8000-000000000001', dentryId: 'pdf-1', scopeId: '40000000-0000-4000-8000-000000000001'
    })
    expect(result).toEqual({ dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, version: 3 })
    expect(net.fetch).toHaveBeenCalledWith(expect.stringContaining('/pdfs/pdf-1/download-ticket'), expect.objectContaining({ cache: 'no-store' }))
    expect(electronSession.fromPartition).toHaveBeenCalledWith('casebang-artwork-preview', { cache: false })
    expect(directFetch).toHaveBeenCalledWith(signedUrl, expect.objectContaining({
      headers: { 'x-signed': 'yes' }, cache: 'no-store', redirect: 'error'
    }))
    expect(net.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects an untrusted signed URL before sending any desktop request', async () => {
    vi.mocked(net.fetch).mockResolvedValue(Response.json({ url: 'https://attacker.example/file', headers: {}, version: 2, sizeBytes: 100 }))
    await expect(new CollaborationService(settings()).artworkPdf({
      workItemId: '30000000-0000-4000-8000-000000000001', dentryId: 'pdf-1', scopeId: '40000000-0000-4000-8000-000000000001'
    })).rejects.toThrow('不受信任')
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('rejects an oversized indexed PDF before downloading from DingTalk', async () => {
    vi.mocked(net.fetch).mockResolvedValue(Response.json({
      url: 'https://example.aliyuncs.com/file', headers: {}, version: 2, sizeBytes: 16 * 1024 * 1024 + 1
    }))
    await expect(new CollaborationService(settings()).artworkPdf({
      workItemId: '30000000-0000-4000-8000-000000000001', dentryId: 'pdf-1', scopeId: '40000000-0000-4000-8000-000000000001'
    })).rejects.toThrow('超过 16 MB')
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('rejects an incomplete direct download rather than comparing a truncated PDF', async () => {
    vi.mocked(net.fetch).mockResolvedValue(Response.json({
      url: 'https://example.aliyuncs.com/file', headers: {}, version: 2, sizeBytes: 200
    }))
    directFetch.mockResolvedValue(new Response(Buffer.from('%PDF-1.7\ntruncated'), { status: 200 }))
    await expect(new CollaborationService(settings()).artworkPdf({
      workItemId: '30000000-0000-4000-8000-000000000001', dentryId: 'pdf-1', scopeId: '40000000-0000-4000-8000-000000000001'
    })).rejects.toThrow('下载不完整')
  })

  it('cancels an in-flight direct download when its preview scope ends', async () => {
    const scopeId = '40000000-0000-4000-8000-000000000001'
    vi.mocked(net.fetch).mockResolvedValue(Response.json({ url: 'https://example.aliyuncs.com/file', headers: {}, version: 3, sizeBytes: 100 }))
    directFetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const service = new CollaborationService(settings())
    const pending = service.artworkPdf({ workItemId: '30000000-0000-4000-8000-000000000001', dentryId: 'pdf-1', scopeId })
    await vi.waitFor(() => expect(directFetch).toHaveBeenCalledOnce())
    service.cancelArtworkPdf({ scopeId })
    await expect(pending).rejects.toThrow('PDF 下载已取消')
  })
})
