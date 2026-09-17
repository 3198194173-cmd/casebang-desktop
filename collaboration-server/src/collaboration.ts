import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { authenticatedUser } from './auth.js'
import type { PrivateStorage } from './storage.js'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_WORKBOOK_SIZE = 64 * 1024 * 1024
const metadataSchema = z.object({
  assigneeId: z.string().uuid(),
  sourceWorkflow: z.enum(['new-series', 'new-products', 'new-models', 'manual']),
  sourceId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(240),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: z.string().uuid()
}).strict()
const actionSchema = z.object({
  action: z.enum(['claim', 'return-source']),
  expectedVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  requestKey: z.string().uuid(),
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
  last_action?: string | null
  last_reason?: string | null
  last_event_at?: Date | null
}

export function registerCollaborationRoutes(app: FastifyInstance, pool: pg.Pool, storage: PrivateStorage): void {
  if (!app.hasContentTypeParser(XLSX_CONTENT_TYPE)) {
    app.addContentTypeParser(XLSX_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: MAX_WORKBOOK_SIZE }, (_request, body, done) => done(null, body))
  }

  app.get('/api/v1/collaboration/members', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    if (actor.business_role !== 'upstream') return reply.code(403).send({ error: 'business_role_forbidden' })
    const result = await pool.query<{
      id: string; display_name: string; avatar_url: string | null; last_login_at: Date
    }>(
      `SELECT id,display_name,avatar_url,last_login_at
       FROM app_users
       WHERE organization_id=$1 AND active=true AND id<>$2 AND business_role='downstream'
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
    const query = request.query as { box?: string }
    const box = query.box === 'sent' ? 'sent' : 'inbox'
    if (!actor.business_role || (actor.business_role === 'upstream' && box !== 'sent') || (actor.business_role === 'downstream' && box !== 'inbox')) {
      return reply.code(403).send({ error: 'business_role_forbidden' })
    }
    const ownership = box === 'sent' ? 'w.origin_id=$2' : 'w.assignee_id=$2'
    const result = await pool.query<WorkItemRow>(
      `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
              w.origin_id,origin.display_name AS origin_name,
              w.assignee_id,assignee.display_name AS assignee_name,
              latest.action AS last_action,latest.payload->>'reason' AS last_reason,
              latest.created_at AS last_event_at
       FROM work_items w
       JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
       JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
       LEFT JOIN LATERAL (
         SELECT action,payload,created_at FROM work_item_events event
         WHERE event.organization_id=w.organization_id AND event.work_item_id=w.id
         ORDER BY event.version DESC LIMIT 1
       ) latest ON true
       WHERE w.organization_id=$1 AND ${ownership}
       ORDER BY w.created_at DESC LIMIT 200`,
      [actor.organization_id, actor.id]
    )
    return reply.header('cache-control', 'no-store').send({ items: result.rows.map(publicWorkItem) })
  })

  app.post('/api/v1/collaboration/work-items', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    if (actor.business_role !== 'upstream') return reply.code(403).send({ error: 'business_role_forbidden' })
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return reply.code(400).send({ error: 'workbook_required' })
    const metadataHeader = request.headers['x-casebang-metadata']
    if (typeof metadataHeader !== 'string') return reply.code(400).send({ error: 'metadata_required' })
    let metadata: z.infer<typeof metadataSchema>
    try {
      metadata = metadataSchema.parse(JSON.parse(Buffer.from(metadataHeader, 'base64url').toString('utf8')))
    } catch {
      return reply.code(400).send({ error: 'invalid_metadata' })
    }
    const actualHash = createHash('sha256').update(request.body).digest('hex')
    if (actualHash !== metadata.sha256) return reply.code(409).send({ error: 'workbook_hash_mismatch' })

    const assignee = await pool.query<{ id: string }>(
      `SELECT id FROM app_users WHERE organization_id=$1 AND id=$2 AND active=true AND business_role='downstream'`,
      [actor.organization_id, metadata.assigneeId]
    )
    if (!assignee.rowCount || metadata.assigneeId === actor.id) return reply.code(400).send({ error: 'invalid_assignee' })

    const existing = await pool.query<WorkItemRow>(
      `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
              w.origin_id,origin.display_name AS origin_name,
              w.assignee_id,assignee.display_name AS assignee_name
       FROM work_items w
       JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
       JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
       JOIN workbook_revisions r ON r.organization_id=w.organization_id AND r.work_item_id=w.id AND r.revision=w.revision
       WHERE w.organization_id=$1 AND w.source_workflow=$2 AND w.source_id=$3 AND r.sha256=$4`,
      [actor.organization_id, metadata.sourceWorkflow, metadata.sourceId, metadata.sha256]
    )
    if (existing.rows[0]) {
      if (existing.rows[0].origin_id !== actor.id || existing.rows[0].assignee_id !== metadata.assigneeId) {
        return reply.code(409).send({ error: 'source_already_submitted' })
      }
      return reply.header('cache-control', 'no-store').send({ item: publicWorkItem(existing.rows[0]), duplicate: true })
    }
    const occupiedSource = await pool.query<{ id: string }>(
      `SELECT id FROM work_items WHERE organization_id=$1 AND source_workflow=$2 AND source_id=$3`,
      [actor.organization_id, metadata.sourceWorkflow, metadata.sourceId]
    )
    if (occupiedSource.rowCount) return reply.code(409).send({ error: 'source_already_submitted' })

    const workItemId = randomUUID()
    const eventId = randomUUID()
    const objectKey = `${actor.organization_id}/${workItemId}/revision-1.xlsx`
    await storage.writeObject(objectKey, request.body)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO work_items
          (id,organization_id,origin_id,assignee_id,source_workflow,source_id,title,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING_PROCESSING')`,
        [workItemId, actor.organization_id, actor.id, metadata.assigneeId, metadata.sourceWorkflow, metadata.sourceId, metadata.title]
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
          { assigneeId: metadata.assigneeId, revision: 1, sha256: metadata.sha256 }]
      )
      await client.query(
        `INSERT INTO outbox_events(id,organization_id,event_id,destination_user_id,payload)
         VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(), actor.organization_id, eventId, metadata.assigneeId,
          { type: 'work-item-assigned', workItemId, title: metadata.title }]
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      await storage.removeObject(objectKey)
      throw error
    } finally {
      client.release()
    }
    const created = await loadWorkItem(pool, actor.organization_id, workItemId)
    return reply.code(201).header('cache-control', 'no-store').send({ item: publicWorkItem(created), duplicate: false })
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
    return reply
      .header('content-type', XLSX_CONTENT_TYPE)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}`)
      .send(createReadStream(storage.resolveObject(row.object_key)))
  })

  app.post('/api/v1/collaboration/work-items/:id/actions', async (request, reply) => {
    const actor = await authenticatedUser(request, reply, pool)
    if (!actor) return
    if (actor.business_role !== 'downstream') return reply.code(403).send({ error: 'business_role_forbidden' })
    const params = request.params as { id?: string }
    const id = z.string().uuid().safeParse(params.id)
    const input = actionSchema.safeParse(request.body)
    if (!id.success || !input.success) return reply.code(400).send({ error: 'invalid_action' })
    if (input.data.action === 'return-source' && !input.data.reason?.trim()) {
      return reply.code(400).send({ error: 'return_reason_required' })
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
      if (item.assignee_id !== actor.id) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'forbidden_action' })
      }
      if (item.version !== input.data.expectedVersion || item.revision !== input.data.revision) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'version_conflict' })
      }
      const expectedState = input.data.action === 'claim' ? 'PENDING_PROCESSING' : 'PROCESSING'
      const nextState = input.data.action === 'claim' ? 'PROCESSING' : 'NEEDS_SOURCE_FIX'
      if (item.state !== expectedState) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'state_conflict' })
      }

      const nextVersion = item.version + 1
      const eventId = randomUUID()
      const payload = input.data.action === 'return-source'
        ? { reason: input.data.reason?.trim(), revision: item.revision }
        : { revision: item.revision }
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
      if (input.data.action === 'return-source') {
        await client.query(
          `INSERT INTO outbox_events(id,organization_id,event_id,destination_user_id,payload)
           VALUES($1,$2,$3,$4,$5)`,
          [randomUUID(), actor.organization_id, eventId, item.origin_id,
            { type: 'work-item-returned', workItemId: item.id, title: item.title, reason: input.data.reason?.trim() }]
        )
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

async function loadWorkItem(pool: pg.Pool, organizationId: string, id: string): Promise<WorkItemRow> {
  const result = await pool.query<WorkItemRow>(
    `SELECT w.id,w.title,w.state,w.source_workflow,w.version,w.revision,w.created_at,
            w.origin_id,origin.display_name AS origin_name,
            w.assignee_id,assignee.display_name AS assignee_name,
            latest.action AS last_action,latest.payload->>'reason' AS last_reason,
            latest.created_at AS last_event_at
     FROM work_items w
     JOIN app_users origin ON origin.organization_id=w.organization_id AND origin.id=w.origin_id
     JOIN app_users assignee ON assignee.organization_id=w.organization_id AND assignee.id=w.assignee_id
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
    assignee: { id: row.assignee_id, displayName: row.assignee_name }
  }
}
