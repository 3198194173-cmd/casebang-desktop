import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { authenticatedUser } from './auth.js'
import type { ServerConfig } from './config.js'
import type { PrivateStorage } from './storage.js'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const OCTET_STREAM = 'application/octet-stream'
const MAX_WORKBOOK_SIZE = 64 * 1024 * 1024
const SESSION_TTL_MS = 4 * 60 * 60 * 1000
const DOWNLOAD_TTL_SECONDS = 10 * 60
const UPLOAD_TTL_MS = 30 * 60 * 1000
const SDK_PATH = resolve(import.meta.dirname, '../public/web-office-sdk-solution-v1.1.27.umd.js')

const uploadAddressSchema = z.object({
  name: z.string().min(1).max(240),
  size: z.number().int().min(1).max(MAX_WORKBOOK_SIZE),
  digest: z.record(z.string(), z.string()),
  is_manual: z.boolean()
}).passthrough()

const uploadCompleteSchema = z.object({
  request: uploadAddressSchema,
  response: z.object({ status_code: z.number().int() }).passthrough(),
  send_back_params: z.record(z.string(), z.string()).optional()
}).passthrough()

interface WebOfficeSessionRow {
  id: string
  organization_id: string
  work_item_id: string
  user_id: string
  display_name: string
  avatar_url: string | null
}

interface FileRow {
  id: string
  organization_id: string
  title: string
  revision: number
  version: number
  created_at: Date
  origin_id: string
  assignee_id: string
  object_key: string
  sha256: string
  revision_created_at: Date
  modifier_id: string
}

interface UploadRow {
  id: string
  organization_id: string
  work_item_id: string
  user_id: string
  session_id: string
  expected_name: string
  expected_size: string | number
  expected_digest: string
  object_key: string
  status: 'prepared' | 'uploaded' | 'completed' | 'failed'
  uploaded_size: string | number | null
  uploaded_digest: string | null
  completed_revision: number | null
}

export function registerWebOfficeRoutes(app: FastifyInstance, config: ServerConfig, pool: pg.Pool, storage: PrivateStorage): void {
  for (const contentType of [XLSX_CONTENT_TYPE, OCTET_STREAM]) {
    if (!app.hasContentTypeParser(contentType)) {
      app.addContentTypeParser(contentType, { parseAs: 'buffer', bodyLimit: MAX_WORKBOOK_SIZE }, (_request, body, done) => done(null, body))
    }
  }

  app.post('/api/v1/collaboration/work-items/:id/weboffice-session', async (request, reply) => {
    if (!config.wps.enabled) return reply.code(503).send({ error: 'weboffice_disabled' })
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const parsedId = z.string().uuid().safeParse((request.params as { id?: string }).id)
    if (!parsedId.success) return reply.code(400).send({ error: 'invalid_work_item' })
    const allowed = await pool.query<{ id: string }>(
      `SELECT id FROM work_items
       WHERE organization_id=$1 AND id=$2 AND (origin_id=$3 OR assignee_id=$3)`,
      [actor.organization_id, parsedId.data, actor.id]
    )
    if (!allowed.rowCount) return reply.code(404).send({ error: 'work_item_not_found' })
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await pool.query(
      `INSERT INTO weboffice_sessions(id,organization_id,work_item_id,user_id,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), actor.organization_id, parsedId.data, actor.id, sha256(token), expiresAt]
    )
    return reply.code(201).header('cache-control', 'no-store').send({
      appId: config.wps.appId,
      fileId: wpsFileId(parsedId.data),
      fileToken: token,
      officeType: 's',
      endpoint: 'https://o.wpsgo.com',
      editorUrl: `${config.publicOrigin}/weboffice/editor?fileId=${wpsFileId(parsedId.data)}#token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString()
    })
  })

  app.get('/weboffice/sdk.js', async (_request, reply) => {
    return reply.header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'public, max-age=604800, immutable').send(createReadStream(SDK_PATH))
  })

  app.get('/weboffice/editor', async (request, reply) => {
    if (!config.wps.enabled) return reply.code(503).type('text/html').send(editorErrorPage('WPS 在线编辑尚未启用。'))
    const fileId = (request.query as { fileId?: string }).fileId
    if (!parseWpsFileId(fileId)) return reply.code(400).type('text/html').send(editorErrorPage('工作簿标识无效。'))
    return reply.header('cache-control', 'no-store').header('content-security-policy', "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src https:; connect-src 'self' https: wss:").type('text/html').send(editorPage(config.wps.appId, fileId!))
  })

  app.get('/weboffice/v3/3rd/files/:fileId', async (request, reply) => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const file = await callbackFile(request, reply, pool, session)
    if (!file) return
    return wpsSuccess(reply, await fileInfo(file, storage))
  })

  app.get('/weboffice/v3/3rd/files/:fileId/download', async (request, reply) => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const file = await callbackFile(request, reply, pool, session)
    if (!file) return
    const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS
    const signature = downloadSignature(config.wps.appSecret, wpsFileId(file.id), file.revision, expires)
    return wpsSuccess(reply, {
      url: `${config.publicOrigin}/weboffice/content/${wpsFileId(file.id)}/${file.revision}?expires=${expires}&signature=${signature}`
    })
  })

  app.get('/weboffice/v3/3rd/files/:fileId/permission', async (request, reply) => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const file = await callbackFile(request, reply, pool, session)
    if (!file) return
    return wpsSuccess(reply, {
      user_id: wpsUserId(session.user_id), read: 1, update: 1, download: 0,
      rename: 0, history: 0, copy: 1, print: 0, saveas: 0, comment: 1
    })
  })

  const usersCallback = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const queryIds = (request.query as { user_ids?: string | string[] }).user_ids
    const bodyIds = (request.body as { user_ids?: string[] } | undefined)?.user_ids
    const raw = bodyIds ?? queryIds
    const requested = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(parseWpsUserId).filter((id): id is string => Boolean(id))
    if (!requested.length) return wpsSuccess(reply, [])
    const result = await pool.query<{ id: string; display_name: string; avatar_url: string | null }>(
      `SELECT id,display_name,avatar_url FROM app_users
       WHERE organization_id=$1 AND active=true AND id=ANY($2::uuid[])`,
      [session.organization_id, requested]
    )
    return wpsSuccess(reply, result.rows.map(user => ({
      id: wpsUserId(user.id), name: user.display_name,
      ...(user.avatar_url?.startsWith('https://') ? { avatar_url: user.avatar_url } : {})
    })))
  }
  app.get('/weboffice/v3/3rd/users', usersCallback)
  app.post('/weboffice/v3/3rd/users', usersCallback)

  app.get('/weboffice/v3/3rd/files/:fileId/upload/prepare', async (request, reply) => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const file = await callbackFile(request, reply, pool, session)
    if (!file) return
    return wpsSuccess(reply, { digest_types: ['sha256'] })
  })

  app.post('/weboffice/v3/3rd/files/:fileId/upload/address', async (request, reply) => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const file = await callbackFile(request, reply, pool, session)
    if (!file) return
    const input = uploadAddressSchema.safeParse(request.body)
    const digest = input.success ? input.data.digest.sha256?.toLowerCase() : undefined
    if (!input.success || !digest || !/^[a-f0-9]{64}$/.test(digest)) return wpsFailure(reply, 400, 40001, 'invalid upload request')
    const uploadId = randomUUID()
    const uploadToken = randomBytes(32).toString('base64url')
    const objectKey = `${file.organization_id}/${file.id}/weboffice-${uploadId}.xlsx`
    await pool.query(
      `INSERT INTO weboffice_uploads
        (id,organization_id,work_item_id,user_id,session_id,upload_token_hash,expected_name,expected_size,digest_type,expected_digest,object_key,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'sha256',$9,$10,$11)`,
      [uploadId, file.organization_id, file.id, session.user_id, session.id, sha256(uploadToken), input.data.name, input.data.size, digest, objectKey, new Date(Date.now() + UPLOAD_TTL_MS)]
    )
    return wpsSuccess(reply, {
      method: 'PUT',
      url: `${config.publicOrigin}/weboffice/upload/${uploadId}`,
      headers: { 'Content-Type': XLSX_CONTENT_TYPE, 'X-Casebang-Upload-Token': uploadToken },
      send_back_params: { upload_id: uploadId }
    })
  })

  app.put('/weboffice/upload/:uploadId', { bodyLimit: MAX_WORKBOOK_SIZE }, async (request, reply) => {
    const params = request.params as { uploadId?: string }
    const uploadToken = request.headers['x-casebang-upload-token']
    const parsedId = z.string().uuid().safeParse(params.uploadId)
    if (!parsedId.success || typeof uploadToken !== 'string' || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'invalid_upload' })
    const result = await pool.query<UploadRow>(
      `SELECT id,organization_id,work_item_id,user_id,session_id,expected_name,expected_size,expected_digest,object_key,status,
              uploaded_size,uploaded_digest,completed_revision
       FROM weboffice_uploads
       WHERE id=$1 AND upload_token_hash=$2 AND expires_at>now()`,
      [parsedId.data, sha256(uploadToken)]
    )
    const upload = result.rows[0]
    if (!upload || upload.status !== 'prepared') return reply.code(409).send({ error: 'upload_not_available' })
    const digest = sha256(request.body)
    if (request.body.length !== Number(upload.expected_size) || digest !== upload.expected_digest) {
      await pool.query(`UPDATE weboffice_uploads SET status='failed' WHERE id=$1`, [upload.id])
      return reply.code(409).send({ error: 'upload_digest_mismatch' })
    }
    await storage.writeObject(upload.object_key, request.body)
    await pool.query(
      `UPDATE weboffice_uploads SET status='uploaded',uploaded_size=$2,uploaded_digest=$3 WHERE id=$1 AND status='prepared'`,
      [upload.id, request.body.length, digest]
    )
    return reply.code(200).header('etag', digest).send({ ok: true })
  })

  app.post('/weboffice/v3/3rd/files/:fileId/upload/complete', async (request, reply) => {
    const session = await callbackSession(request, reply, config, pool)
    if (!session) return
    const file = await callbackFile(request, reply, pool, session)
    if (!file) return
    const input = uploadCompleteSchema.safeParse(request.body)
    const uploadId = input.success ? input.data.send_back_params?.upload_id : undefined
    const parsedUploadId = z.string().uuid().safeParse(uploadId)
    if (!input.success || !parsedUploadId.success || input.data.response.status_code < 200 || input.data.response.status_code >= 300) {
      return wpsFailure(reply, 400, 40001, 'upload incomplete')
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const uploadResult = await client.query<UploadRow>(
        `SELECT id,organization_id,work_item_id,user_id,session_id,expected_name,expected_size,expected_digest,object_key,status,
                uploaded_size,uploaded_digest,completed_revision
         FROM weboffice_uploads WHERE id=$1 AND organization_id=$2 AND work_item_id=$3 FOR UPDATE`,
        [parsedUploadId.data, session.organization_id, file.id]
      )
      const upload = uploadResult.rows[0]
      if (!upload || (upload.status !== 'uploaded' && upload.status !== 'completed')) {
        await client.query('ROLLBACK')
        return wpsFailure(reply, 409, 40001, 'upload not found')
      }
      if (upload.status === 'completed' && upload.completed_revision) {
        await client.query('COMMIT')
        const completed = await revisionFile(pool, session.organization_id, file.id, upload.completed_revision)
        return wpsSuccess(reply, await fileInfo(completed, storage))
      }
      const locked = await client.query<FileRow>(
        `SELECT w.id,w.organization_id,w.title,w.revision,w.version,w.created_at,w.origin_id,w.assignee_id,
                r.object_key,r.sha256,r.created_at AS revision_created_at,r.created_by AS modifier_id
         FROM work_items w JOIN workbook_revisions r
           ON r.organization_id=w.organization_id AND r.work_item_id=w.id AND r.revision=w.revision
         WHERE w.organization_id=$1 AND w.id=$2 FOR UPDATE OF w`,
        [session.organization_id, file.id]
      )
      const current = locked.rows[0]
      if (!current) throw new Error('weboffice_work_item_missing')
      const nextRevision = current.revision + 1
      const nextVersion = current.version + 1
      await client.query(
        `INSERT INTO workbook_revisions(organization_id,work_item_id,revision,object_key,sha256,created_by)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [session.organization_id, file.id, nextRevision, upload.object_key, upload.uploaded_digest, session.user_id]
      )
      await client.query(`UPDATE work_items SET revision=$3,version=$4 WHERE organization_id=$1 AND id=$2`, [session.organization_id, file.id, nextRevision, nextVersion])
      const eventId = randomUUID()
      await client.query(
        `INSERT INTO work_item_events(id,organization_id,work_item_id,actor_id,request_key,request_hash,version,action,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,'weboffice-save',$8)`,
        [eventId, session.organization_id, file.id, session.user_id, upload.id, upload.uploaded_digest, nextVersion,
          { revision: nextRevision, sha256: upload.uploaded_digest }]
      )
      const destination = session.user_id === current.origin_id ? current.assignee_id : current.origin_id
      await client.query(
        `INSERT INTO outbox_events(id,organization_id,event_id,destination_user_id,payload) VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(), session.organization_id, eventId, destination,
          { type: 'workbook-revision-saved', workItemId: file.id, title: current.title, revision: nextRevision }]
      )
      await client.query(
        `UPDATE weboffice_uploads SET status='completed',completed_revision=$2,completed_at=now() WHERE id=$1`,
        [upload.id, nextRevision]
      )
      await client.query('COMMIT')
      const completed = await revisionFile(pool, session.organization_id, file.id, nextRevision)
      return wpsSuccess(reply, await fileInfo(completed, storage))
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/weboffice/content/:fileId/:revision', async (request, reply) => {
    if (!config.wps.enabled) return reply.code(404).send()
    const params = request.params as { fileId?: string; revision?: string }
    const query = request.query as { expires?: string; signature?: string }
    const workItemId = parseWpsFileId(params.fileId)
    const revision = Number(params.revision)
    const expires = Number(query.expires)
    if (!workItemId || !Number.isInteger(revision) || revision < 1 || !Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || !query.signature) {
      return reply.code(403).send({ error: 'download_expired' })
    }
    const expected = downloadSignature(config.wps.appSecret, params.fileId!, revision, expires)
    if (!safeEqual(expected, query.signature)) return reply.code(403).send({ error: 'download_forbidden' })
    const file = await revisionFile(pool, undefined, workItemId, revision)
    return reply.header('content-type', XLSX_CONTENT_TYPE).header('cache-control', 'private, no-store').send(createReadStream(storage.resolveObject(file.object_key)))
  })
}

async function callbackSession(request: FastifyRequest, reply: FastifyReply, config: ServerConfig, pool: pg.Pool): Promise<WebOfficeSessionRow | null> {
  if (!config.wps.enabled) { await wpsFailure(reply, 503, 40001, 'WebOffice disabled'); return null }
  if (!verifyWpsSignature(request, config)) { await wpsFailure(reply, 401, 40001, 'invalid signature'); return null }
  const token = request.headers['x-weboffice-token']
  if (typeof token !== 'string' || token.length < 32) { await wpsFailure(reply, 401, 40001, 'token required'); return null }
  const result = await pool.query<WebOfficeSessionRow>(
    `UPDATE weboffice_sessions s SET last_seen_at=now()
     FROM app_users u
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
       AND u.organization_id=s.organization_id AND u.id=s.user_id AND u.active=true
     RETURNING s.id,s.organization_id,s.work_item_id,s.user_id,u.display_name,u.avatar_url`,
    [sha256(token)]
  )
  const session = result.rows[0]
  if (!session) { await wpsFailure(reply, 401, 40001, 'token expired'); return null }
  return session
}

async function callbackFile(request: FastifyRequest, reply: FastifyReply, pool: pg.Pool, session: WebOfficeSessionRow): Promise<FileRow | null> {
  const requestedId = parseWpsFileId((request.params as { fileId?: string }).fileId)
  if (!requestedId || requestedId !== session.work_item_id) { await wpsFailure(reply, 404, 40004, 'file not exists'); return null }
  try { return await revisionFile(pool, session.organization_id, requestedId) } catch {
    await wpsFailure(reply, 404, 40004, 'file not exists'); return null
  }
}

async function revisionFile(pool: pg.Pool, organizationId: string | undefined, workItemId: string, revision?: number): Promise<FileRow> {
  const result = await pool.query<FileRow>(
    `SELECT w.id,w.organization_id,w.title,w.revision,w.version,w.created_at,w.origin_id,w.assignee_id,
            r.object_key,r.sha256,r.created_at AS revision_created_at,r.created_by AS modifier_id
     FROM work_items w JOIN workbook_revisions r
       ON r.organization_id=w.organization_id AND r.work_item_id=w.id AND r.revision=${revision ? '$3' : 'w.revision'}
     WHERE w.id=$1 AND ($2::uuid IS NULL OR w.organization_id=$2)`,
    revision ? [workItemId, organizationId ?? null, revision] : [workItemId, organizationId ?? null]
  )
  if (!result.rows[0]) throw new Error('weboffice_file_missing')
  return result.rows[0]
}

async function fileInfo(file: FileRow, storage: PrivateStorage): Promise<object> {
  return {
    id: wpsFileId(file.id), name: safeFileName(file.title), version: file.revision,
    size: await storage.objectSize(file.object_key),
    create_time: Math.floor(file.created_at.getTime() / 1000),
    modify_time: Math.floor(file.revision_created_at.getTime() / 1000),
    creator_id: wpsUserId(file.origin_id), modifier_id: wpsUserId(file.modifier_id)
  }
}

function verifyWpsSignature(request: FastifyRequest, config: ServerConfig): boolean {
  const appId = request.headers['x-app-id']
  const date = request.headers.date
  const contentMd5 = request.headers['content-md5']
  const authorization = request.headers.authorization
  if (appId !== config.wps.appId || typeof date !== 'string' || typeof contentMd5 !== 'string' || typeof authorization !== 'string') return false
  const timestamp = Date.parse(date)
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) return false
  const contentType = request.method === 'GET' ? '' : (request.headers['content-type'] ?? '').split(';')[0]!
  const digest = createHash('sha1').update(`${config.wps.appSecret}${contentMd5}${contentType}${date}`).digest('hex')
  return safeEqual(`WPS-2:${config.wps.appId}:${digest}`, authorization)
}

function downloadSignature(secret: string, fileId: string, revision: number, expires: number): string {
  return createHmac('sha256', secret).update(`${fileId}:${revision}:${expires}`).digest('hex')
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function wpsFileId(id: string): string { return `f${id.replaceAll('-', '')}` }
function wpsUserId(id: string): string { return `u${id.replaceAll('-', '')}` }
function parseWpsFileId(value?: string): string | null { return parseWpsUuid(value, 'f') }
function parseWpsUserId(value?: string): string | null { return parseWpsUuid(value, 'u') }
function parseWpsUuid(value: string | undefined, prefix: 'f' | 'u'): string | null {
  if (!value || !new RegExp(`^${prefix}[a-f0-9]{32}$`).test(value)) return null
  const raw = value.slice(1)
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}
function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/|":*?<>]/g, '_').slice(0, 235)
  return cleaned.toLowerCase().endsWith('.xlsx') ? cleaned : `${cleaned}.xlsx`
}
function wpsSuccess(reply: FastifyReply, data: unknown): FastifyReply {
  return reply.header('cache-control', 'no-store').send({ code: 0, message: '', data })
}
function wpsFailure(reply: FastifyReply, status: number, code: number, message: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send({ code, message })
}

function editorPage(appId: string, fileId: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CASEBANG 共享工作簿</title><style>*{box-sizing:border-box}html,body,#weboffice{width:100%;height:100%;margin:0}body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f7f7f5}.status{position:fixed;z-index:2;left:16px;bottom:16px;padding:8px 12px;border-radius:8px;background:#fff;border:1px solid #ddd;color:#444;box-shadow:0 6px 20px #0002}.error{color:#b42318}</style></head><body><div id="weboffice"></div><div id="status" class="status">正在连接共享工作簿…</div><script src="./sdk.js"></script><script>(()=>{const status=document.getElementById('status');const fragment=new URLSearchParams(location.hash.slice(1));const token=fragment.get('token');history.replaceState(null,'',location.pathname+location.search);if(!token||!window.WebOfficeSDK){status.textContent='编辑凭证无效，请返回 CASEBANG 重新打开。';status.classList.add('error');return}const instance=WebOfficeSDK.init({officeType:WebOfficeSDK.OfficeType.Spreadsheet,appId:${JSON.stringify(appId)},fileId:${JSON.stringify(fileId)},token:{token,timeout:${SESSION_TTL_MS - 60_000}},endpoint:'https://o.wpsgo.com',mount:'#weboffice'});instance.on('fileOpen',data=>{if(data&&data.success){status.textContent='已连接同一份共享工作簿';setTimeout(()=>status.remove(),2500)}else{status.textContent='工作簿打开失败，请检查 WPS 回调配置。';status.classList.add('error')}});instance.on('error',()=>{status.textContent='WPS 在线编辑发生错误，请重新打开。';status.classList.add('error')})})()</script></body></html>`
}

function editorErrorPage(message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无法打开共享工作簿</title></head><body style="font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;background:#f7f7f5"><main style="max-width:560px;margin:12vh auto;padding:32px;background:white;border:1px solid #ddd;border-radius:14px"><h1>无法打开共享工作簿</h1><p>${message}</p><p>请关闭本页并返回 CASEBANG 桌面版。</p></main></body></html>`
}
