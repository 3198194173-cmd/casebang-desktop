import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ServerConfig } from './config.js'
import { type DingTalkUserGrant } from './dingtalk-oauth.js'

const REFRESH_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken'

export class DingTalkUserGrantError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DingTalkUserGrantError' }
}

interface GrantRow {
  access_token_ciphertext: string
  refresh_token_ciphertext: string | null
  token_nonce: string
  token_tag: string
  expires_at: Date | null
  token_type: string | null
  scopes: string[] | null
  key_version: number
}

interface TokenResponse { accessToken?: string; refreshToken?: string; expireIn?: number; tokenType?: string; scope?: string | string[] }

export class DingTalkUserGrantStore {
  private readonly key: Buffer
  private readonly refreshes = new Map<string, Promise<string>>()

  constructor(private readonly config: ServerConfig, private readonly pool: pg.Pool, private readonly fetcher: typeof fetch = fetch) {
    const configured = config.dingtalk.userTokenEncryptionKey
    // Development/test can use the client secret-derived key; production deployments
    // should set DINGTALK_USER_TOKEN_ENCRYPTION_KEY_FILE to an independent 32-byte secret.
    this.key = configured ? createHash('sha256').update(configured).digest() : createHash('sha256').update(`${config.dingtalk.clientSecret}:casebang-user-grant`).digest()
  }

  async save(userId: string, organizationId: string, grant: DingTalkUserGrant, executor: pg.Pool | pg.PoolClient = this.pool): Promise<void> {
    const encrypted = encrypt(JSON.stringify({ accessToken: grant.accessToken, refreshToken: grant.refreshToken }), this.key)
    await executor.query(
      `INSERT INTO dingtalk_user_grants(id,organization_id,user_id,access_token_ciphertext,refresh_token_ciphertext,token_nonce,token_tag,expires_at,token_type,scopes,key_version,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,now())
       ON CONFLICT(organization_id,user_id) DO UPDATE SET access_token_ciphertext=EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,token_nonce=EXCLUDED.token_nonce,token_tag=EXCLUDED.token_tag,
         expires_at=EXCLUDED.expires_at,token_type=EXCLUDED.token_type,scopes=EXCLUDED.scopes,key_version=1,revoked_at=NULL,updated_at=now()`,
      [randomUUID(), organizationId, userId, encrypted.ciphertext, null, encrypted.nonce, encrypted.tag, grant.expiresAt, grant.tokenType, grant.scopes]
    )
  }

  async accessToken(userId: string, organizationId: string): Promise<string> {
    const result = await this.pool.query<GrantRow>(
      `SELECT access_token_ciphertext,refresh_token_ciphertext,token_nonce,token_tag,expires_at,token_type,scopes,key_version
       FROM dingtalk_user_grants WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [organizationId, userId]
    )
    const row = result.rows[0]
    if (!row) throw new DingTalkUserGrantError('dingtalk_personal_grant_required', '当前下游账号尚未授权个人钉盘。')
    const secrets = decryptGrant(row, this.key)
    if (!row.expires_at || row.expires_at.getTime() > Date.now() + 60_000) return secrets.accessToken
    if (!secrets.refreshToken) throw new DingTalkUserGrantError('dingtalk_personal_token_refresh_failed', '个人钉盘授权已过期，请重新登录钉钉授权。')
    const key = `${organizationId}:${userId}`
    const existing = this.refreshes.get(key)
    if (existing) return existing
    const pending = this.refresh(userId, organizationId, secrets.refreshToken).finally(() => this.refreshes.delete(key))
    this.refreshes.set(key, pending)
    return pending
  }

  async revoke(userId: string, organizationId: string): Promise<void> {
    await this.pool.query('UPDATE dingtalk_user_grants SET revoked_at=now(),updated_at=now() WHERE organization_id=$1 AND user_id=$2', [organizationId, userId])
  }

  private async refresh(userId: string, organizationId: string, refreshToken: string): Promise<string> {
    const response = await this.fetcher(REFRESH_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.config.dingtalk.clientId, clientSecret: this.config.dingtalk.clientSecret, grantType: 'refresh_token', refreshToken }),
      signal: AbortSignal.timeout(15_000)
    })
    const body = await response.json().catch(() => undefined) as TokenResponse | undefined
    if (!response.ok || !body?.accessToken) {
      await this.revoke(userId, organizationId)
      throw new DingTalkUserGrantError('dingtalk_personal_token_refresh_failed', '个人钉盘授权已失效，请重新登录钉钉授权。')
    }
    const grant: DingTalkUserGrant = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken ?? refreshToken,
      expiresAt: typeof body.expireIn === 'number' ? new Date(Date.now() + body.expireIn * 1000) : null,
      tokenType: body.tokenType ?? null,
      // The refresh response may omit scope too; do not turn that into a
      // false claim that only openid was granted.
      scopes: Array.isArray(body.scope) ? body.scope : typeof body.scope === 'string' ? body.scope.split(/[ ,]+/).filter(Boolean) : []
    }
    await this.save(userId, organizationId, grant)
    return grant.accessToken
  }
}

function encrypt(value: string, key: Buffer): { ciphertext: string; nonce: string; tag: string } {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: ciphertext.toString('base64url'), nonce: nonce.toString('base64url'), tag: tag.toString('base64url') }
}

function decryptGrant(row: GrantRow, key: Buffer): { accessToken: string; refreshToken: string | null } {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.token_nonce, 'base64url'))
    decipher.setAuthTag(Buffer.from(row.token_tag, 'base64url'))
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.access_token_ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as { accessToken?: string; refreshToken?: string | null }
    if (!payload.accessToken) throw new Error('access_token_missing')
    return { accessToken: payload.accessToken, refreshToken: payload.refreshToken ?? null }
  } catch { throw new DingTalkUserGrantError('dingtalk_personal_grant_corrupt', '个人钉盘授权凭据无法解密，请重新登录钉钉授权。') }
}
