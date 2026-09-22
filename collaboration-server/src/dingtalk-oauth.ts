import type { ServerConfig } from './config.js'

const LOGIN_ENDPOINT = 'https://login.dingtalk.com/oauth2/auth'
const USER_TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken'
const USER_PROFILE_ENDPOINT = 'https://api.dingtalk.com/v1.0/contact/users/me'
const APP_TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const MEMBER_LOOKUP_ENDPOINT = 'https://oapi.dingtalk.com/topapi/user/getbyunionid'

interface UserTokenResponse {
  accessToken?: string
  refreshToken?: string
  expireIn?: number
  tokenType?: string
  scope?: string | string[]
}

interface UserProfileResponse {
  nick?: string
  unionId?: string
  openId?: string
  avatarUrl?: string
}

interface AppTokenResponse {
  accessToken?: string
}

interface MemberLookupResponse {
  errcode?: number
  errmsg?: string
  result?: { userid?: string }
}

export interface DingTalkIdentity {
  userId: string
  unionId: string
  openId: string | null
  displayName: string
  avatarUrl: string | null
}

export interface DingTalkUserGrant {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  tokenType: string | null
  scopes: string[]
}

export class DingTalkOAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DingTalkOAuthError'
  }
}

export class DingTalkOAuthClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  authorizationUrl(state: string): string {
    const query = new URLSearchParams({
      redirect_uri: `${this.config.publicOrigin}/api/v1/auth/dingtalk/callback`,
      response_type: 'code',
      client_id: this.config.dingtalk.clientId,
      scope: 'openid',
      state,
      prompt: 'consent'
    })
    return `${LOGIN_ENDPOINT}?${query.toString()}`
  }

  async authenticate(authCode: string): Promise<DingTalkIdentity> {
    const result = await this.authenticateWithGrant(authCode)
    return result.identity
  }

  async authenticateWithGrant(authCode: string): Promise<{ identity: DingTalkIdentity; grant: DingTalkUserGrant }> {
    const token = await this.requestJson<UserTokenResponse>(USER_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: this.config.dingtalk.clientId,
        clientSecret: this.config.dingtalk.clientSecret,
        code: authCode,
        grantType: 'authorization_code'
      })
    })
    if (!token.accessToken) throw new DingTalkOAuthError('user_token_missing', '钉钉未返回用户访问令牌')

    const profile = await this.requestJson<UserProfileResponse>(USER_PROFILE_ENDPOINT, {
      headers: { 'x-acs-dingtalk-access-token': token.accessToken }
    })
    if (!profile.unionId || !profile.nick) {
      throw new DingTalkOAuthError('profile_incomplete', '钉钉登录资料缺少 unionId 或昵称')
    }

    const appToken = await this.requestJson<AppTokenResponse>(APP_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appKey: this.config.dingtalk.clientId,
        appSecret: this.config.dingtalk.clientSecret
      })
    })
    if (!appToken.accessToken) throw new DingTalkOAuthError('app_token_missing', '钉钉未返回企业应用访问令牌')

    const memberUrl = new URL(MEMBER_LOOKUP_ENDPOINT)
    memberUrl.searchParams.set('access_token', appToken.accessToken)
    const member = await this.requestJson<MemberLookupResponse>(memberUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unionid: profile.unionId })
    })
    if (member.errcode !== 0 || !member.result?.userid) {
      throw new DingTalkOAuthError('not_enterprise_member', member.errmsg || '登录账号不属于当前企业或应用无成员读取权限')
    }

    return {
      grant: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        expiresAt: typeof token.expireIn === 'number' ? new Date(Date.now() + token.expireIn * 1000) : null,
        tokenType: token.tokenType ?? null,
        scopes: normalizeScopes(token.scope)
      },
      identity: {
        userId: member.result.userid,
        unionId: profile.unionId,
        openId: profile.openId ?? null,
        displayName: profile.nick,
        avatarUrl: profile.avatarUrl ?? null
      }
    }
  }

  private async requestJson<T>(url: string | URL, init: RequestInit): Promise<T> {
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) })
    const body = await response.json().catch(() => undefined) as T | undefined
    if (!response.ok || !body) {
      throw new DingTalkOAuthError('upstream_failure', `钉钉接口调用失败（HTTP ${response.status}）`)
    }
    return body
  }
}

function normalizeScopes(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string') return value.split(/[ ,]+/).map(item => item.trim()).filter(Boolean)
  return ['openid']
}
