import { shell } from 'electron'
import type { CollaborationAccountState, CollaborationUser } from '@shared/contracts'
import type { CollaborationSession, SettingsRepository } from '@main/infrastructure/settings-repository'

const SERVICE_ORIGIN = 'https://casebang.tech/collab'
const POLL_INTERVAL_MS = 1_500

interface LoginStartResponse {
  attemptId: string
  pollToken: string
  authorizationUrl: string
  expiresAt: string
}

interface LoginStatusResponse {
  status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'consumed'
  errorCode?: string
  sessionToken?: string
  expiresAt?: string
  user?: CollaborationUser
}

interface AccountResponse {
  user?: CollaborationUser
}

interface SessionStore {
  getApplicationSettings(): Promise<{ allowNetworkFeatures: boolean }>
  getCollaborationSession(): Promise<CollaborationSession | null>
  setCollaborationSession(input: CollaborationSession): Promise<void>
  clearCollaborationSession(): Promise<void>
}

type OpenExternal = (url: string) => Promise<void>
type Delay = (milliseconds: number) => Promise<void>

export class CollaborationAuthService {
  private activeLogin: Promise<CollaborationAccountState> | null = null

  constructor(
    private readonly settings: SessionStore | SettingsRepository,
    private readonly fetcher: typeof fetch = fetch,
    private readonly openExternal: OpenExternal = (url) => shell.openExternal(url),
    private readonly delay: Delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))
  ) {}

  async get(): Promise<CollaborationAccountState> {
    const session = await this.settings.getCollaborationSession()
    if (!session) return signedOut()
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.settings.clearCollaborationSession()
      return { ...signedOut(), message: '登录已过期，请重新登录。' }
    }
    try {
      const response = await this.fetcher(`${SERVICE_ORIGIN}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${session.sessionToken}` },
        signal: AbortSignal.timeout(12_000)
      })
      if (response.status === 401) {
        await this.settings.clearCollaborationSession()
        return { ...signedOut(), message: '服务器会话已失效，请重新登录。' }
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as AccountResponse
      if (!body.user) throw new Error('账号资料缺失')
      const refreshed = { ...session, user: body.user }
      await this.settings.setCollaborationSession(refreshed)
      return signedIn(body.user)
    } catch {
      return {
        status: 'offline',
        user: session.user,
        message: '已保留本机登录信息，但暂时无法连接协同服务。'
      }
    }
  }

  login(): Promise<CollaborationAccountState> {
    if (this.activeLogin) return this.activeLogin
    this.activeLogin = this.performLogin().finally(() => { this.activeLogin = null })
    return this.activeLogin
  }

  async logout(): Promise<CollaborationAccountState> {
    const session = await this.settings.getCollaborationSession()
    try {
      if (session) {
        await this.fetcher(`${SERVICE_ORIGIN}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${session.sessionToken}` },
          signal: AbortSignal.timeout(8_000)
        })
      }
    } catch {
      // A local sign-out must still succeed when the central service is temporarily unavailable.
    } finally {
      await this.settings.clearCollaborationSession()
    }
    return signedOut()
  }

  private async performLogin(): Promise<CollaborationAccountState> {
    const application = await this.settings.getApplicationSettings()
    if (!application.allowNetworkFeatures) throw new Error('联网功能已关闭，请先在系统设置中开启。')
    const startResponse = await this.fetcher(`${SERVICE_ORIGIN}/api/v1/auth/dingtalk/start`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    })
    if (!startResponse.ok) throw new Error(`协同服务暂时无法发起登录（HTTP ${startResponse.status}）`)
    const start = await startResponse.json() as LoginStartResponse
    if (!isLoginStart(start)) throw new Error('协同服务返回的登录信息不完整')
    await this.openExternal(start.authorizationUrl)

    const expiresAt = Date.parse(start.expiresAt)
    let consecutiveNetworkFailures = 0
    while (Date.now() < expiresAt) {
      await this.delay(POLL_INTERVAL_MS)
      try {
        const response = await this.fetcher(`${SERVICE_ORIGIN}/api/v1/auth/dingtalk/status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ attemptId: start.attemptId, pollToken: start.pollToken }),
          signal: AbortSignal.timeout(12_000)
        })
        consecutiveNetworkFailures = 0
        const result = await response.json().catch(() => ({ status: 'failed', errorCode: `http_${response.status}` })) as LoginStatusResponse
        if (result.status === 'pending') continue
        if (result.status === 'succeeded' && result.sessionToken && result.expiresAt && result.user) {
          await this.settings.setCollaborationSession({
            sessionToken: result.sessionToken,
            expiresAt: result.expiresAt,
            user: result.user
          })
          return signedIn(result.user)
        }
        throw new Error(loginFailureMessage(result))
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('钉钉')) throw error
        consecutiveNetworkFailures += 1
        if (consecutiveNetworkFailures >= 3) throw new Error('无法连接协同服务，请检查网络后重试。')
      }
    }
    throw new Error('钉钉登录等待超时，请重新发起。')
  }
}

function isLoginStart(value: LoginStartResponse): boolean {
  if (!(value.attemptId && value.pollToken && value.authorizationUrl && value.expiresAt)) return false
  try {
    const authorization = new URL(value.authorizationUrl)
    return authorization.protocol === 'https:' && authorization.hostname === 'login.dingtalk.com'
  } catch {
    return false
  }
}

function loginFailureMessage(result: LoginStatusResponse): string {
  const messages: Record<string, string> = {
    authorization_denied: '已取消钉钉授权。',
    authorization_code_missing: '钉钉没有返回授权码，请重新登录。',
    not_enterprise_member: '该钉钉账号不属于当前企业或不在应用可见范围内。',
    consumed: '本次登录已经被领取，请重新发起。',
    expired: '本次登录已经过期，请重新发起。'
  }
  return messages[result.errorCode ?? result.status] ?? '钉钉登录未完成，请检查应用权限后重试。'
}

function signedOut(): CollaborationAccountState {
  return { status: 'signed-out', user: null, message: '尚未登录钉钉账号。' }
}

function signedIn(user: CollaborationUser): CollaborationAccountState {
  return { status: 'signed-in', user, message: '钉钉账号已连接。' }
}
