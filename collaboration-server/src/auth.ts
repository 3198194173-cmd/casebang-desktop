import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ServerConfig } from './config.js'
import { DingTalkOAuthClient, DingTalkOAuthError } from './dingtalk-oauth.js'
import { DingTalkUserGrantStore } from './dingtalk-user-grant.js'

const ATTEMPT_TTL_MS = 10 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface AttemptRow {
  id: string
  status: 'pending' | 'succeeded' | 'failed'
  organization_id: string | null
  user_id: string | null
  error_code: string | null
  expires_at: Date
  delivered_at: Date | null
  requested_business_role: 'upstream' | 'downstream' | null
}

export interface SessionUserRow {
  id: string
  display_name: string
  avatar_url: string | null
  organization_id: string
  corp_id: string
  business_role: 'upstream' | 'downstream' | null
  dingtalk_union_id?: string | null
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function callbackPage(ok: boolean, message: string): string {
  const title = ok ? '登录成功' : '登录未完成'
  const color = ok ? '#087f5b' : '#b42318'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f7f7f5;font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#18181b"><main style="max-width:520px;margin:12vh auto;padding:32px;background:white;border:1px solid #e4e4e7;border-radius:16px"><h1 style="margin:0 0 12px;font-size:26px;color:${color}">${title}</h1><p style="line-height:1.7">${message}</p><p style="color:#71717a">现在可以关闭此页面并返回 CASEBANG 桌面版。</p></main></body></html>`
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice(7).trim()
  return token.length >= 32 ? token : null
}

export function registerAuthRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  pool: pg.Pool,
  oauth: DingTalkOAuthClient = new DingTalkOAuthClient(config),
  grants: DingTalkUserGrantStore = new DingTalkUserGrantStore(config, pool)
): void {
  app.get('/login', async (_request, reply) => {
    return reply.header('cache-control', 'no-store').type('text/html').send(
      callbackPage(true, '服务已就绪。请从 CASEBANG Windows 桌面版点击“钉钉登录”发起授权。')
    )
  })

  app.post('/api/v1/auth/dingtalk/start', async (request, reply) => {
    const body = request.body as { businessRole?: string } | undefined
    if (body?.businessRole !== 'upstream' && body?.businessRole !== 'downstream') {
      return reply.code(400).send({ error: 'business_role_required' })
    }
    await pool.query("DELETE FROM auth_attempts WHERE expires_at < now() - interval '1 day'")
    const attemptId = randomUUID()
    const state = randomToken()
    const pollToken = randomToken()
    const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS)
    await pool.query(
      `INSERT INTO auth_attempts(id,state_hash,poll_token_hash,expires_at,requested_business_role)
       VALUES($1,$2,$3,$4,$5)`,
      [attemptId, hash(state), hash(pollToken), expiresAt, body.businessRole]
    )
    return reply.code(201).header('cache-control', 'no-store').send({
      attemptId,
      pollToken,
      authorizationUrl: oauth.authorizationUrl(state),
      expiresAt: expiresAt.toISOString()
    })
  })

  app.get('/api/v1/auth/dingtalk/callback', async (request, reply) => {
    const query = request.query as { state?: string; authCode?: string; code?: string; error?: string }
    if (!query.state) return reply.code(400).type('text/html').send(callbackPage(false, '登录状态参数缺失，请从桌面版重新发起登录。'))
    const stateHash = hash(query.state)
    const found = await pool.query<AttemptRow>(
      `SELECT id,status,organization_id,user_id,error_code,expires_at,delivered_at,requested_business_role
       FROM auth_attempts WHERE state_hash=$1`,
      [stateHash]
    )
    const attempt = found.rows[0]
    if (!attempt || attempt.status !== 'pending' || attempt.expires_at.getTime() <= Date.now()) {
      return reply.code(400).type('text/html').send(callbackPage(false, '本次登录已失效或已处理，请返回桌面版重新登录。'))
    }
    if (!attempt.requested_business_role) {
      await failAttempt(pool, attempt.id, 'business_role_required')
      return reply.code(400).type('text/html').send(callbackPage(false, '本次登录未选择业务身份，请从桌面版重新登录。'))
    }
    const authCode = query.authCode ?? query.code
    if (query.error || !authCode) {
      await failAttempt(pool, attempt.id, query.error ? 'authorization_denied' : 'authorization_code_missing')
      return reply.code(400).type('text/html').send(callbackPage(false, '钉钉授权被取消或没有返回授权码。'))
    }

    try {
      const authenticated = await oauth.authenticateWithGrant(authCode)
      const identity = authenticated.identity
      request.log.info({
        requestedScopes: config.dingtalk.userScopes.split(/[ ,]+/).filter(Boolean),
        reportedScopes: authenticated.grant.scopes.length ? authenticated.grant.scopes : null,
        scopeReportedByDingTalk: authenticated.grant.scopes.length > 0
      }, '钉钉用户授权范围已确认')
      let savedOrganizationId = ''
      let savedUserId = ''
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const organizationId = randomUUID()
        const organization = await client.query<{ id: string }>(
          `INSERT INTO organizations(id,corp_id,name) VALUES($1,$2,$3)
           ON CONFLICT(corp_id) DO UPDATE SET name=EXCLUDED.name
           RETURNING id`,
          [organizationId, config.dingtalk.corpId, 'CASEBANG']
        )
        const actualOrganizationId = organization.rows[0]?.id
        if (!actualOrganizationId) throw new Error('organization_upsert_failed')
        const newUserId = randomUUID()
        const user = await client.query<{ id: string }>(
          `INSERT INTO app_users
             (id,organization_id,dingtalk_user_id,dingtalk_union_id,dingtalk_open_id,display_name,avatar_url,business_role)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(organization_id,dingtalk_user_id) DO UPDATE SET
             dingtalk_union_id=EXCLUDED.dingtalk_union_id,
             dingtalk_open_id=EXCLUDED.dingtalk_open_id,
             display_name=EXCLUDED.display_name,
             avatar_url=EXCLUDED.avatar_url,
             business_role=EXCLUDED.business_role,
             active=true,
             last_login_at=now()
           RETURNING id`,
          [newUserId, actualOrganizationId, identity.userId, identity.unionId, identity.openId, identity.displayName, identity.avatarUrl, attempt.requested_business_role]
        )
        const actualUserId = user.rows[0]?.id
        if (!actualUserId) throw new Error('user_upsert_failed')
        savedOrganizationId = actualOrganizationId
        savedUserId = actualUserId
        const updated = await client.query(
          `UPDATE auth_attempts SET status='succeeded',organization_id=$2,user_id=$3,completed_at=now()
           WHERE id=$1 AND status='pending' AND expires_at>now()`,
          [attempt.id, actualOrganizationId, actualUserId]
        )
        if (updated.rowCount !== 1) throw new Error('auth_attempt_no_longer_pending')
        await grants.save(savedUserId, savedOrganizationId, authenticated.grant, client)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      return reply.header('cache-control', 'no-store').type('text/html').send(callbackPage(true, `已确认钉钉账号：${escapeHtml(identity.displayName)}。`))
    } catch (error) {
      const errorCode = error instanceof DingTalkOAuthError ? error.code : 'login_processing_failed'
      await failAttempt(pool, attempt.id, errorCode)
      request.log.warn({ errorCode }, '钉钉登录失败')
      return reply.code(400).header('cache-control', 'no-store').type('text/html').send(callbackPage(false, '无法确认企业账号，请检查应用权限后从桌面版重试。'))
    }
  })

  app.post('/api/v1/auth/dingtalk/status', async (request, reply) => {
    const body = request.body as { attemptId?: string; pollToken?: string } | undefined
    if (!body?.attemptId || !body.pollToken) return reply.code(400).send({ error: 'invalid_request' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<AttemptRow>(
        `SELECT id,status,organization_id,user_id,error_code,expires_at,delivered_at,requested_business_role
         FROM auth_attempts WHERE id=$1 AND poll_token_hash=$2 FOR UPDATE`,
        [body.attemptId, hash(body.pollToken)]
      )
      const attempt = result.rows[0]
      if (!attempt) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'login_attempt_not_found' })
      }
      if (attempt.expires_at.getTime() <= Date.now()) {
        await client.query('ROLLBACK')
        return reply.code(410).send({ status: 'expired' })
      }
      if (attempt.status === 'pending') {
        await client.query('COMMIT')
        return reply.header('cache-control', 'no-store').send({ status: 'pending' })
      }
      if (attempt.status === 'failed') {
        await client.query('COMMIT')
        return reply.code(400).header('cache-control', 'no-store').send({ status: 'failed', errorCode: attempt.error_code })
      }
      if (!attempt.organization_id || !attempt.user_id || attempt.delivered_at) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ status: 'consumed' })
      }
      const sessionToken = randomToken()
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
      await client.query(
        `INSERT INTO user_sessions(id,organization_id,user_id,token_hash,expires_at)
         VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(), attempt.organization_id, attempt.user_id, hash(sessionToken), expiresAt]
      )
      await client.query('UPDATE auth_attempts SET delivered_at=now() WHERE id=$1', [attempt.id])
      const user = await client.query<SessionUserRow>(
        `SELECT u.id,u.display_name,u.avatar_url,u.organization_id,o.corp_id,u.business_role
         FROM app_users u JOIN organizations o ON o.id=u.organization_id
         WHERE u.organization_id=$1 AND u.id=$2`,
        [attempt.organization_id, attempt.user_id]
      )
      await client.query('COMMIT')
      return reply.header('cache-control', 'no-store').send({
        status: 'succeeded',
        sessionToken,
        expiresAt: expiresAt.toISOString(),
        user: publicUser(user.rows[0])
      })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/api/v1/auth/me', async (request, reply) => {
    const user = await authenticatedUser(request, reply, pool)
    if (!user) return
    return reply.header('cache-control', 'no-store').send({ user: publicUser(user) })
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = bearerToken(request)
    if (!token) return reply.code(401).send({ error: 'unauthorized' })
    await pool.query('UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hash(token)])
    return reply.code(204).send()
  })
}

async function failAttempt(pool: pg.Pool, attemptId: string, errorCode: string): Promise<void> {
  await pool.query(
    `UPDATE auth_attempts SET status='failed',error_code=$2,completed_at=now()
     WHERE id=$1 AND status='pending'`,
    [attemptId, errorCode]
  )
}

export async function authenticatedUser(request: FastifyRequest, reply: FastifyReply, pool: pg.Pool): Promise<SessionUserRow | null> {
  const token = bearerToken(request)
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' })
    return null
  }
  const result = await pool.query<SessionUserRow>(
    `UPDATE user_sessions s SET last_seen_at=now()
     FROM app_users u, organizations o
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
       AND u.organization_id=s.organization_id AND u.id=s.user_id AND u.active=true
       AND o.id=s.organization_id
     RETURNING u.id,u.display_name,u.avatar_url,u.organization_id,o.corp_id,u.business_role,u.dingtalk_union_id`,
    [hash(token)]
  )
  const user = result.rows[0]
  if (!user) {
    await reply.code(401).send({ error: 'session_expired' })
    return null
  }
  return user
}

function publicUser(user: SessionUserRow | undefined): object | null {
  if (!user) return null
  return {
    id: user.id,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    organizationId: user.organization_id,
    corpId: user.corp_id,
    businessRole: user.business_role
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}
