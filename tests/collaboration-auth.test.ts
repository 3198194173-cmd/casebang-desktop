import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { CollaborationAuthService } from '../src/main/modules/collaboration/collaboration-auth-service'
import type { CollaborationUser } from '../src/shared/contracts'
import type { CollaborationSession } from '../src/main/infrastructure/settings-repository'

const USER: CollaborationUser = {
  id: 'user-1',
  displayName: '卓志',
  avatarUrl: null,
  organizationId: 'org-1',
  corpId: 'ding-company',
  businessRole: 'upstream'
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function store(initial: CollaborationSession | null = null) {
  let session = initial
  return {
    getCollaborationSession: vi.fn(async () => session),
    setCollaborationSession: vi.fn(async (value: CollaborationSession) => { session = value }),
    clearCollaborationSession: vi.fn(async () => { session = null }),
    current: () => session
  }
}

describe('desktop DingTalk account login', () => {
  it('opens the trusted DingTalk authorization page and stores a successful session', async () => {
    const state = store()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        attemptId: 'attempt-1',
        pollToken: 'poll-1',
        authorizationUrl: 'https://login.dingtalk.com/oauth2/auth?client_id=test',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }))
      .mockResolvedValueOnce(response({ status: 'pending' }))
      .mockResolvedValueOnce(response({
        status: 'succeeded',
        sessionToken: 'session-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: USER
      }))
    const openExternal = vi.fn(async () => undefined)
    const service = new CollaborationAuthService(state, fetcher, openExternal, async () => undefined)

    await expect(service.login('upstream')).resolves.toMatchObject({ status: 'signed-in', user: USER })
    expect(fetcher).toHaveBeenNthCalledWith(1, expect.stringContaining('/auth/dingtalk/start'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ businessRole: 'upstream' })
    }))
    expect(openExternal).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/login\.dingtalk\.com\//))
    expect(state.current()).toMatchObject({ sessionToken: 'session-1', user: USER })
  })

  it('rejects an authorization URL that is not owned by DingTalk', async () => {
    const fetcher = vi.fn(async () => response({
      attemptId: 'attempt-1',
      pollToken: 'poll-1',
      authorizationUrl: 'https://example.com/fake-login',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }))
    const openExternal = vi.fn(async () => undefined)
    const service = new CollaborationAuthService(store(), fetcher, openExternal, async () => undefined)

    await expect(service.login('upstream')).rejects.toThrow('登录信息不完整')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('explains a reset HTTPS connection before DingTalk authorization starts', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
    const service = new CollaborationAuthService(store(), vi.fn(async () => { throw reset }), async () => undefined, async () => undefined)

    await expect(service.login('upstream')).rejects.toThrow('HTTPS 连接被中途关闭')
  })

  it('keeps the verified user available offline and clears local login even if logout cannot reach the server', async () => {
    const session: CollaborationSession = {
      sessionToken: 'session-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: USER
    }
    const state = store(session)
    const fetcher = vi.fn(async () => { throw new Error('offline') })
    const service = new CollaborationAuthService(state, fetcher, async () => undefined, async () => undefined)

    await expect(service.get()).resolves.toMatchObject({ status: 'offline', user: USER })
    await expect(service.logout()).resolves.toMatchObject({ status: 'signed-out', user: null })
    expect(state.current()).toBeNull()
  })

  it('removes a server-rejected session instead of showing a stale account', async () => {
    const state = store({
      sessionToken: 'expired-on-server',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: USER
    })
    const service = new CollaborationAuthService(state, vi.fn(async () => response({}, 401)), async () => undefined, async () => undefined)

    await expect(service.get()).resolves.toMatchObject({ status: 'signed-out', user: null })
    expect(state.current()).toBeNull()
  })
})
