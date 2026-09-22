import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DingTalkOAuthClient, DingTalkOAuthError } from '../src/dingtalk-oauth.js'

const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://collab.casebang.tech',
  DB_PASSWORD: 'database-test',
  DINGTALK_STREAM_ENABLED: 'true',
  DINGTALK_CORP_ID: 'ding-corp',
  DINGTALK_CLIENT_ID: 'ding-client',
  DINGTALK_AGENT_ID: '12345',
  DINGTALK_CLIENT_SECRET: 'client-secret-test'
})

describe('DingTalk OAuth client', () => {
  it('builds the registered callback URL and keeps state intact', () => {
    const client = new DingTalkOAuthClient(config)
    const url = new URL(client.authorizationUrl('state-value'))
    expect(url.origin + url.pathname).toBe('https://login.dingtalk.com/oauth2/auth')
    expect(url.searchParams.get('redirect_uri')).toBe('https://collab.casebang.tech/api/v1/auth/dingtalk/callback')
    expect(url.searchParams.get('client_id')).toBe('ding-client')
    expect(url.searchParams.get('scope')).toBe('openid Files.Read')
    expect(url.searchParams.get('state')).toBe('state-value')
  })

  it('exchanges the authorization code and verifies enterprise membership', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/userAccessToken')) return Response.json({ accessToken: 'user-access' })
      if (url.endsWith('/contact/users/me')) return Response.json({ nick: '测试用户', unionId: 'union-1', openId: 'open-1', avatarUrl: 'https://example.test/avatar.png' })
      if (url.endsWith('/oauth2/accessToken')) return Response.json({ accessToken: 'app-access' })
      if (url.includes('/topapi/user/getbyunionid')) return Response.json({ errcode: 0, result: { userid: 'staff-1' } })
      return new Response(null, { status: 404 })
    })
    const client = new DingTalkOAuthClient(config, fetcher as typeof fetch)
    await expect(client.authenticate('temporary-code')).resolves.toEqual({
      userId: 'staff-1',
      unionId: 'union-1',
      openId: 'open-1',
      displayName: '测试用户',
      avatarUrl: 'https://example.test/avatar.png'
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('rejects a DingTalk account that cannot be mapped into the configured enterprise', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/userAccessToken')) return Response.json({ accessToken: 'user-access' })
      if (url.endsWith('/contact/users/me')) return Response.json({ nick: '外部账号', unionId: 'union-external' })
      if (url.endsWith('/oauth2/accessToken')) return Response.json({ accessToken: 'app-access' })
      return Response.json({ errcode: 60121, errmsg: '找不到该用户' })
    })
    const client = new DingTalkOAuthClient(config, fetcher as typeof fetch)
    await expect(client.authenticate('temporary-code')).rejects.toMatchObject<DingTalkOAuthError>({ code: 'not_enterprise_member' })
  })
})
