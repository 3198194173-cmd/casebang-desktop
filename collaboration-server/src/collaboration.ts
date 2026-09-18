import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { authenticatedUser, type SessionUserRow } from './auth.js'
import type { PrivateStorage } from './storage.js'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const BINARY_CONTENT_TYPE = 'application/octet-stream'
const MAX_WORKBOOK_SIZE = 64 * 1024 * 1024
const UPLOAD_CHUNK_SIZE = 64 * 1024
const UPLOAD_TTL_MS = 30 * 60 * 1000
const metadataSchema = z.object({
  assigneeId: z.string().uuid().optional(),
  sourceWorkflow: z.enum(['new-series', 'new-products', 'new-models', 'manual']),
  sourceId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(240),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: z.string().uuid()
}).strict()
const uploadPrepareSchema = metadataSchema.extend({
  size: z.number().int().positive().max(MAX_WORKBOOK_SIZE)
}).strict()
const uploadChunkSchema = z.object({
  data: z.string().min(4).max(Math.ceil(UPLOAD_CHUNK_SIZE / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/)
}).strict()
const uploadManifestSchema = z.object({
  uploadId: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  metadata: metadataSchema,
  size: z.number().int().positive().max(MAX_WORKBOOK_SIZE),
  chunkSize: z.number().int().positive().max(UPLOAD_CHUNK_SIZE),
  totalChunks: z.number().int().positive(),
  objectKey: z.string().optional(),
  expiresAt: z.string().datetime()
}).strict()
const actionSchema = z.object({
  action: z.enum(['claim', 'return-source', 'update-stage']),
  expectedVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  requestKey: z.string().uuid(),
  state: z.enum(['PENDING_PROCESSING', 'PROCESSING', 'PENDING_ORIGIN_REVIEW', 'NEEDS_SOURCE_FIX', 'READY_TO_MERGE', 'COMPLETED']).optional(),
  reason: z.string().trim().max(1_000).optional()
}).strict()

interface WorkItemRow {
  id: string
  title: string
  state: string
  source_workflow: string
  version: number
  revision: number
  created_at: Date
  origin_id: string
  origin_name: string
  assignee_id: string
  assignee_name: string
  modifier_id?: string
  modifier_name?: string
  revision_created_at?: Date
  last_action?: string | null
  last_reason?: string | null
  last_event_at?: Date | null
}

export function registerCollaborationRoutes(app: FastifyInstance, pool: pg.Pool, storage: PrivateStorage): void {
  if (!app.hasContentTypeParser(XLSX_CONTENT_TYPE)) {
    app.addContentTypeParser(XLSX_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: MAX_WORKBOOK_SIZE }, (_request, body, done) => done(null, body))
  }
  if (!app.hasContentTypeParser(BINARY_CONTENT_TYPE)) {
    app.addContentTypeParser(BINARY_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: UPLOAD_CHUNK_SIZE }, (_request, body, done) => done(null, body))
  }

  app.get('/api/v1/collaboration/members', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const result = await pool.query<{
      id: string; display_name: string; avatar_url: string | null; last_login_at: Date
    }>(
      `SELECT id,display_name,avatar_url,last_login_at
       FROM app_users
       WHERE organization_id=$1 AND active=true AND id<>$2
       ORDER BY last_login_at DESC,display_name`,
      [actor.organization_id, actor.id]
    )
    return reply.header('cache-control', 'no-store').send({
      members: result.rows.map(row => ({
        id: row.id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        lastLoginAt: row.last_login_at.toISOString()
      }))
    })
  })

  app.get('/api/v1/collaboration/work-items', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const result = await pool.query<WorkItemRow>(
      `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
              w.origin_id,origin.display_name AS origin_name,
              w.assignee_id,assignee.display_name AS assignee_name,
              revision.created_by AS modifier_id,modifier.display_name AS modifier_name,
              revision.created_at AS revision_created_at,
              latest.action AS last_action,latest.payload->>'reason' AS last_reason,
              latest.created_at AS last_event_at
       FROM work_items w
       JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
       JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
       JOIN workbook_revisions revision
         ON revision.organization_id=w.organization_id AND revision.work_item_id=w.id AND revision.revision=w.revision
       JOIN app_users modifier
         ON modifier.organization_id=revision.organization_id AND modifier.id=revision.created_by
       LEFT JOIN LATERAL (
         SELECT action,payload,created_at FROM work_item_events event
         WHERE event.organization_id=w.organization_id AND event.work_item_id=w.id
         ORDER BY event.version DESC LIMIT 1
       ) latest ON true
       WHERE w.organization_id=$1 AND (w.origin_id=$2 OR w.assignee_id=$2)
       ORDER BY w.created_at DESC LIMIT 200`,
      [actor.organization_id, actor.id]
    )
    return reply.header('cache-control', 'no-store').send({ items: result.rows.map(publicWorkItem) })
  })

  app.post('/api/v1/collaboration/workbook-uploads', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const input = uploadPrepareSchema.safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: 'invalid_upload_request' })
    const { size, ...metadata } = input.data
    const uploadId = randomUUID()
    const totalChunks = Math.ceil(size / UPLOAD_CHUNK_SIZE)
    const objectKey = storage.supportsDirectTransfer ? `${uploadRoot(actor, uploadId)}/workbook.xlsx` : undefined
    const manifest: z.infer<typeof uploadManifestSchema> = {
      uploadId,
      organizationId: actor.organization_id,
      userId: actor.id,
      metadata,
      size,
      chunkSize: UPLOAD_CHUNK_SIZE,
      totalChunks,
      ...(objectKey ? { objectKey } : {}),
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString()
    }
    await storage.writeObject(uploadManifestKey(actor, uploadId), Buffer.from(JSON.stringify(manifest)))
    const cleanup = setTimeout(() => {
      void storage.removeTree(uploadRoot(actor, uploadId)).catch(() => undefined)
    }, UPLOAD_TTL_MS + 60_000)
    cleanup.unref()
    return reply.code(201).header('cache-control', 'no-store').send(objectKey ? {
      uploadId,
      uploadMode: 'direct',
      uploadUrl: storage.createUploadUrl(objectKey),
      headers: {
        'content-type': XLSX_CONTENT_TYPE,
        'x-cos-meta-sha256': metadata.sha256
      },
      expiresAt: manifest.expiresAt
    } : { uploadId, uploadMode: 'chunked', chunkSize: UPLOAD_CHUNK_SIZE, totalChunks })
  })

  app.post('/api/v1/collaboration/workbook-uploads/:uploadId/chunks/:index', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const params = request.params as { uploadId?: string; index?: string }
    const uploadId = z.string().uuid().safeParse(params.uploadId)
    const index = z.coerce.number().int().nonnegative().safeParse(params.index)
    if (!uploadId.success || !index.success) {
      return reply.code(400).send({ error: 'invalid_upload_chunk' })
    }
    let chunk: Buffer
    if (Buffer.isBuffer(request.body)) {
      chunk = request.body
    } else {
      const input = uploadChunkSchema.safeParse(request.body)
      if (!input.success) return reply.code(400).send({ error: 'invalid_upload_chunk' })
      chunk = Buffer.from(input.data.data, 'base64')
      if (chunk.toString('base64') !== input.data.data) return reply.code(400).send({ error: 'invalid_upload_chunk' })
    }
    const manifest = await readUploadManifest(storage, actor, uploadId.data)
    if (!manifest) return reply.code(404).send({ error: 'upload_not_found' })
    if (index.data >= manifest.totalChunks) return reply.code(400).send({ error: 'invalid_upload_chunk' })
    const expectedSize = index.data === manifest.totalChunks - 1
      ? manifest.size - manifest.chunkSize * (manifest.totalChunks - 1)
      : manifest.chunkSize
    if (chunk.length !== expectedSize) return reply.code(409).send({ error: 'upload_chunk_size_mismatch' })
    await storage.writeObject(uploadChunkKey(actor, uploadId.data, index.data), chunk)
    return reply.code(204).send()
  })

  app.post('/api/v1/collaboration/workbook-uploads/:uploadId/complete', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const params = request.params as { uploadId?: string }
    const uploadId = z.string().uuid().safeParse(params.uploadId)
    if (!uploadId.success) return reply.code(400).send({ error: 'invalid_upload_request' })
    const manifest = await readUploadManifest(storage, actor, uploadId.data)
    if (!manifest) return reply.code(404).send({ error: 'upload_not_found' })
    if (manifest.objectKey) {
      let workbook: Buffer
      try {
        workbook = await storage.readObject(manifest.objectKey)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(409).send({ error: 'upload_incomplete' })
        throw error
      }
      if (workbook.length !== manifest.size || createHash('sha256').update(workbook).digest('hex') !== manifest.metadata.sha256) {
        return reply.code(409).send({ error: 'workbook_hash_mismatch' })
      }
      const result = await submitWorkbook(actor, manifest.metadata, workbook, pool, storage)
      if (result.status < 400) await storage.removeTree(uploadRoot(actor, uploadId.data))
      return reply.code(result.status).header('cache-control', 'no-store').send(result.body)
    }
    const chunks: Buffer[] = []
    for (let index = 0; index < manifest.totalChunks; index += 1) {
      try {
        const chunk = await storage.readObject(uploadChunkKey(actor, uploadId.data, index))
        const expectedSize = index === manifest.totalChunks - 1
          ? manifest.size - manifest.chunkSize * (manifest.totalChunks - 1)
          : manifest.chunkSize
        if (chunk.length !== expectedSize) return reply.code(409).send({ error: 'upload_chunk_size_mismatch' })
        chunks.push(chunk)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(409).send({ error: 'upload_incomplete' })
        throw error
      }
    }
    const workbook = Buffer.concat(chunks, manifest.size)
    const result = await submitWorkbook(actor, manifest.metadata, workbook, pool, storage)
    if (result.status < 400) await storage.removeTree(uploadRoot(actor, uploadId.data))
    return reply.code(result.status).header('cache-control', 'no-store').send(result.body)
  })

  app.post('/api/v1/collaboration/work-items', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return reply.code(400).send({ error: 'workbook_required' })
    const metadataHeader = request.headers['x-casebang-metadata']
    if (typeof metadataHeader !== 'string') return reply.code(400).send({ error: 'metadata_required' })
    let metadata: z.infer<typeof metadataSchema>
    try {
      metadata = metadataSchema.parse(JSON.parse(Buffer.from(metadataHeader, 'base64url').toString('utf8')))
    } catch {
      return reply.code(400).send({ error: 'invalid_metadata' })
    }
    const result = await submitWorkbook(actor, metadata, request.body, pool, storage)
    return reply.code(result.status).header('cache-control', 'no-store').send(result.body)
  })

  app.get('/api/v1/collaboration/work-items/:id/workbook', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const params = request.params as { id?: string }
    const id = z.string().uuid().safeParse(params.id)
    if (!id.success) return reply.code(400).send({ error: 'invalid_work_item' })
    const result = await pool.query<{ object_key: string; title: string }>(
      `SELECT r.object_key,w.title FROM work_items w
       JOIN workbook_revisions r ON r.organization_id=w.organization_id AND r.work_item_id=w.id AND r.revision=w.revision
       WHERE w.organization_id=$1 AND w.id=$2 AND (w.origin_id=$3 OR w.assignee_id=$3)`,
      [actor.organization_id, id.data, actor.id]
    )
    const row = result.rows[0]
    if (!row) return reply.code(404).send({ error: 'work_item_not_found' })
    if (storage.supportsDirectTransfer) {
      return reply.redirect(storage.createDownloadUrl(row.object_key))
    }
    return reply
      .header('content-type', XLSX_CONTENT_TYPE)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}`)
      .send(await storage.readObject(row.object_key))
  })

  app.post('/api/v1/collaboration/work-items/:id/actions', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    const params = request.params as { id?: string }
    const id = z.string().uuid().safeParse(params.id)
    const input = actionSchema.safeParse(request.body)
    if (!id.success || !input.success) return reply.code(400).send({ error: 'invalid_action' })
    if (input.data.action === 'return-source' && !input.data.reason?.trim()) {
      return reply.code(400).send({ error: 'return_reason_required' })
    }
    if (input.data.action === 'update-stage' && !input.data.state) {
      return reply.code(400).send({ error: 'stage_required' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const requestHash = createHash('sha256').update(JSON.stringify(input.data)).digest('hex')
      const duplicate = await client.query<{ work_item_id: string; request_hash: string }>(
        `SELECT work_item_id,request_hash FROM work_item_events
         WHERE organization_id=$1 AND request_key=$2 AND actor_id=$3`,
        [actor.organization_id, input.data.requestKey, actor.id]
      )
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].work_item_id !== id.data || duplicate.rows[0].request_hash !== requestHash) {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: 'idempotency_conflict' })
        }
        await client.query('COMMIT')
        const item = await loadWorkItem(pool, actor.organization_id, duplicate.rows[0].work_item_id)
        return reply.header('cache-control', 'no-store').send({ item: publicWorkItem(item), duplicate: true })
      }

      const found = await client.query<WorkItemRow>(
        `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
                w.origin_id,origin.display_name AS origin_name,
                w.assignee_id,assignee.display_name AS assignee_name
         FROM work_items w
         JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
         JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
         WHERE w.organization_id=$1 AND w.id=$2 FOR UPDATE OF w`,
        [actor.organization_id, id.data]
      )
      const item = found.rows[0]
      if (!item) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'work_item_not_found' })
      }
      const isParticipant = item.origin_id === actor.id || item.assignee_id === actor.id
      if ((input.data.action === 'update-stage' && !isParticipant) || (input.data.action !== 'update-stage' && item.assignee_id !== actor.id)) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'forbidden_action' })
      }
      if (item.version !== input.data.expectedVersion || item.revision !== input.data.revision) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'version_conflict' })
      }
      const expectedState = input.data.action === 'claim' ? 'PENDING_PROCESSING' : input.data.action === 'return-source' ? 'PROCESSING' : null
      const nextState = input.data.action === 'claim' ? 'PROCESSING' : input.data.action === 'return-source' ? 'NEEDS_SOURCE_FIX' : input.data.state!
      if ((expectedState && item.state !== expectedState) || (!expectedState && item.state === nextState)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'state_conflict' })
      }

      const nextVersion = item.version + 1
      const eventId = randomUUID()
      const payload = input.data.action === 'return-source'
        ? { reason: input.data.reason?.trim(), revision: item.revision, state: nextState }
        : { revision: item.revision, state: nextState }
      await client.query(
        `UPDATE work_items SET state=$3,version=$4
         WHERE organization_id=$1 AND id=$2`,
        [actor.organization_id, item.id, nextState, nextVersion]
      )
      await client.query(
        `INSERT INTO work_item_events
          (id,organization_id,work_item_id,actor_id,request_key,request_hash,version,action,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [eventId, actor.organization_id, item.id, actor.id, input.data.requestKey,
          requestHash,
          nextVersion, input.data.action, payload]
      )
      if (input.data.action === 'return-source' || input.data.action === 'update-stage') {
        const destinationUserId = input.data.action === 'return-source'
          ? item.origin_id
          : actor.id === item.origin_id ? item.assignee_id : item.origin_id
        if (destinationUserId !== actor.id) {
          await client.query(
            `INSERT INTO outbox_events(id,organization_id,event_id,destination_user_id,payload)
             VALUES($1,$2,$3,$4,$5)`,
            [randomUUID(), actor.organization_id, eventId, destinationUserId,
              input.data.action === 'return-source'
                ? { type: 'work-item-returned', workItemId: item.id, title: item.title, reason: input.data.reason?.trim() }
                : { type: 'work-item-stage-updated', workItemId: item.id, title: item.title, state: nextState }]
          )
        }
      }
      await client.query('COMMIT')
      const updated = await loadWorkItem(pool, actor.organization_id, item.id)
      return reply.header('cache-control', 'no-store').send({ item: publicWorkItem(updated), duplicate: false })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })
}

function uploadRoot(actor: SessionUserRow, uploadId: string): string {
  return `${actor.organization_id}/workbook-uploads/${actor.id}/${uploadId}`
}

function uploadManifestKey(actor: SessionUserRow, uploadId: string): string {
  return `${uploadRoot(actor, uploadId)}/manifest.json`
}

function uploadChunkKey(actor: SessionUserRow, uploadId: string, index: number): string {
  return `${uploadRoot(actor, uploadId)}/chunk-${index}.bin`
}

async function readUploadManifest(
  storage: PrivateStorage,
  actor: SessionUserRow,
  uploadId: string
): Promise<z.infer<typeof uploadManifestSchema> | null> {
  try {
    const manifest = uploadManifestSchema.parse(JSON.parse((await storage.readObject(uploadManifestKey(actor, uploadId))).toString('utf8')))
    if (manifest.organizationId !== actor.organization_id || manifest.userId !== actor.id) return null
    if (Date.parse(manifest.expiresAt) <= Date.now()) {
      await storage.removeTree(uploadRoot(actor, uploadId))
      return null
    }
    return manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function submitWorkbook(
  actor: SessionUserRow,
  metadata: z.infer<typeof metadataSchema>,
  workbook: Buffer,
  pool: pg.Pool,
  storage: PrivateStorage
): Promise<{ status: number; body: object }> {
  const actualHash = createHash('sha256').update(workbook).digest('hex')
  if (actualHash !== metadata.sha256) return { status: 409, body: { error: 'workbook_hash_mismatch' } }

  const existing = await pool.query<WorkItemRow>(
    `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
            w.origin_id,origin.display_name AS origin_name,
            w.assignee_id,assignee.display_name AS assignee_name,
            r.created_by AS modifier_id,modifier.display_name AS modifier_name,
            r.created_at AS revision_created_at
     FROM work_items w
     JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
     JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
     JOIN workbook_revisions r ON r.organization_id=w.organization_id AND r.work_item_id=w.id AND r.revision=w.revision
     JOIN app_users modifier ON modifier.organization_id=r.organization_id AND modifier.id=r.created_by
     WHERE w.organization_id=$1 AND w.source_workflow=$2 AND w.source_id=$3 AND r.sha256=$4`,
    [actor.organization_id, metadata.sourceWorkflow, metadata.sourceId, metadata.sha256]
  )
  if (existing.rows[0]) {
    if (existing.rows[0].origin_id !== actor.id || (metadata.assigneeId && existing.rows[0].assignee_id !== metadata.assigneeId)) {
      return { status: 409, body: { error: 'source_already_submitted' } }
    }
    return { status: 200, body: { item: publicWorkItem(existing.rows[0]), duplicate: true } }
  }
  const occupiedSource = await pool.query<{ id: string }>(
    `SELECT id FROM work_items WHERE organization_id=$1 AND source_workflow=$2 AND source_id=$3`,
    [actor.organization_id, metadata.sourceWorkflow, metadata.sourceId]
  )
  if (occupiedSource.rowCount) return { status: 409, body: { error: 'source_already_submitted' } }

  let assigneeId = metadata.assigneeId
  if (assigneeId) {
    const assignee = await pool.query<{ id: string }>(
      `SELECT id FROM app_users WHERE organization_id=$1 AND id=$2 AND active=true`,
      [actor.organization_id, assigneeId]
    )
    if (!assignee.rowCount) return { status: 400, body: { error: 'invalid_assignee' } }
  } else {
    const downstream = await pool.query<{ id: string }>(
      `SELECT id FROM app_users
       WHERE organization_id=$1 AND id<>$2 AND active=true AND business_role='downstream'
       ORDER BY last_login_at DESC LIMIT 1`,
      [actor.organization_id, actor.id]
    )
    assigneeId = downstream.rows[0]?.id ?? actor.id
  }

  const workItemId = randomUUID()
  const eventId = randomUUID()
  const objectKey = `${actor.organization_id}/${workItemId}/revision-1.xlsx`
  await storage.writeObject(objectKey, workbook, metadata.sha256)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO work_items
        (id,organization_id,origin_id,assignee_id,source_workflow,source_id,title,state)
       VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING_PROCESSING')`,
      [workItemId, actor.organization_id, actor.id, assigneeId, metadata.sourceWorkflow, metadata.sourceId, metadata.title]
    )
    await client.query(
      `INSERT INTO workbook_revisions
        (organization_id,work_item_id,revision,object_key,sha256,created_by)
       VALUES($1,$2,1,$3,$4,$5)`,
      [actor.organization_id, workItemId, objectKey, metadata.sha256, actor.id]
    )
    await client.query(
      `INSERT INTO work_item_events
        (id,organization_id,work_item_id,actor_id,request_key,request_hash,version,action,payload)
       VALUES($1,$2,$3,$4,$5,$6,1,'submit',$7)`,
      [eventId, actor.organization_id, workItemId, actor.id, metadata.requestKey,
        createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
        { assigneeId, revision: 1, sha256: metadata.sha256 }]
    )
    if (assigneeId !== actor.id) {
      await client.query(
        `INSERT INTO outbox_events(id,organization_id,event_id,destination_user_id,payload)
         VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(), actor.organization_id, eventId, assigneeId,
          { type: 'workbook-published', workItemId, title: metadata.title, state: 'PENDING_PROCESSING' }]
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    await storage.removeObject(objectKey)
    throw error
  } finally {
    client.release()
  }
  const created = await loadWorkItem(pool, actor.organization_id, workItemId)
  return { status: 201, body: { item: publicWorkItem(created), duplicate: false } }
}

async function loadWorkItem(pool: pg.Pool, organizationId: string, id: string): Promise<WorkItemRow> {
  const result = await pool.query<WorkItemRow>(
    `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
            w.origin_id,origin.display_name AS origin_name,
            w.assignee_id,assignee.display_name AS assignee_name,
            revision.created_by AS modifier_id,modifier.display_name AS modifier_name,
            revision.created_at AS revision_created_at,
            latest.action AS last_action,latest.payload->>'reason' AS last_reason,
            latest.created_at AS last_event_at
     FROM work_items w
     JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
     JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
     JOIN workbook_revisions revision
       ON revision.organization_id=w.organization_id AND revision.work_item_id=w.id AND revision.revision=w.revision
     JOIN app_users modifier
       ON modifier.organization_id=revision.organization_id AND modifier.id=revision.created_by
     LEFT JOIN LATERAL (
       SELECT action,payload,created_at FROM work_item_events event
       WHERE event.organization_id=w.organization_id AND event.work_item_id=w.id
       ORDER BY event.version DESC LIMIT 1
     ) latest ON true
     WHERE w.organization_id=$1 AND w.id=$2`,
    [organizationId, id]
  )
  if (!result.rows[0]) throw new Error('work_item_create_failed')
  return result.rows[0]
}

function publicWorkItem(row: WorkItemRow): object {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    sourceWorkflow: row.source_workflow,
    version: row.version,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    lastAction: row.last_action ?? null,
    lastReason: row.last_reason ?? null,
    lastEventAt: row.last_event_at?.toISOString() ?? null,
    origin: { id: row.origin_id, displayName: row.origin_name },
    assignee: { id: row.assignee_id, displayName: row.assignee_name },
    lastEditor: { id: row.modifier_id ?? row.origin_id, displayName: row.modifier_name ?? row.origin_name },
    lastEditedAt: (row.revision_created_at ?? row.created_at).toISOString()
  }
}
