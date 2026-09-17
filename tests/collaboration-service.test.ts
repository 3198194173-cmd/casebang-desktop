import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\CasebangTest') },
  net: { fetch: vi.fn() },
  shell: { openPath: vi.fn(async () => '') }
}))

import { net } from 'electron'
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
  beforeEach(() => vi.mocked(net.fetch).mockReset())

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
    await writeFile(workbookPath, Buffer.from('xlsx-test'))
    const item = { id: '30000000-0000-4000-8000-000000000001', title: '新建产品表.xlsx', state: 'PENDING_PROCESSING', sourceWorkflow: 'new-series', version: 1, revision: 1, createdAt: '2026-09-17T00:00:00.000Z', origin: { id: 'user-1', displayName: '建表人' }, assignee: { id: 'user-2', displayName: '加工人' } }
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ item, duplicate: false }), { status: 201 }))
    try {
      const result = await new CollaborationService(settings()).publishWorkbook({ path: workbookPath, title: '新建产品表.xlsx', sourceWorkflow: 'new-series' })
      expect(result.item.state).toBe('PENDING_PROCESSING')
      const request = vi.mocked(net.fetch).mock.calls[0]
      const headers = request?.[1]?.headers as Record<string, string>
      const metadata = JSON.parse(Buffer.from(headers['x-casebang-metadata']!, 'base64url').toString('utf8'))
      expect(metadata).toEqual(expect.objectContaining({ sourceWorkflow: 'new-series', title: '新建产品表.xlsx' }))
      expect(metadata).not.toHaveProperty('assigneeId')
    } finally {
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
})
