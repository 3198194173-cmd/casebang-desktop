import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { net } from 'electron'
import { CollaborationService } from '../src/main/modules/collaboration/collaboration-service'
import type { SettingsRepository } from '../src/main/infrastructure/settings-repository'

const session = {
  sessionToken: 'session-token-for-tests',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  user: { id: 'user-1', displayName: '卓志', avatarUrl: null, organizationId: 'org-1', corpId: 'corp-1' }
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
    await expect(new CollaborationService(value).workItems('inbox')).rejects.toThrow('登录已失效')
    expect(value.clearCollaborationSession).toHaveBeenCalledOnce()
  })
})
