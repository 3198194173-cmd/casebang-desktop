import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { authenticatedUser, type SessionUserRow } from './auth.js'
import { DingTalkDriveClient, DingTalkDriveError, type DingTalkDentry } from './dingtalk-drive.js'

const bindSchema = z.object({ folderUrl: z.string().url().max(1000) }).strict()
const searchSchema = z.object({ query: z.string().trim().max(200).default(''), limit: z.coerce.number().int().min(1).max(100).default(30) })

interface SourceRow { id: string; folder_url: string; node_id: string; space_id: string; folder_name: string; status: string; file_count: number; folder_count: number; last_error: string | null; indexed_at: Date | null }
interface EntryRow { dentry_id: string; parent_id: string | null; name: string; entry_type: string; extension: string | null; size_bytes: string | number | null; version: string | number | null; path: string | null; modified_at: Date | null }

export function registerArtworkRoutes(app: FastifyInstance, pool: pg.Pool, drive: DingTalkDriveClient): void {
  app.get('/api/v1/dingtalk/artwork-source', async (request, reply) => {
    const actor = await downstreamUser(request, reply, pool); if (!actor) return
    const source = await loadSource(pool, actor)
    return reply.header('cache-control', 'no-store').send({ source: source ? publicSource(source) : null })
  })

  app.put('/api/v1/dingtalk/artwork-source', async (request, reply) => {
    const actor = await downstreamUser(request, reply, pool); if (!actor) return
    const input = bindSchema.safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: 'invalid_artwork_source' })
    const nodeId = parseNodeId(input.data.folderUrl)
    if (!nodeId) return reply.code(400).send({ error: 'invalid_artwork_source' })
    try {
      const indexed = await resolveAndStore(pool, drive, actor, input.data.folderUrl, nodeId)
      return reply.header('cache-control', 'no-store').send({ source: publicSource(indexed) })
    } catch (error) {
      const code = error instanceof DingTalkDriveError ? error.code : 'dingtalk_drive_failure'
      request.log.warn({ code }, 'Personal artwork source binding failed')
      return reply.code(code === 'artwork_source_not_folder' ? 400 : 502).send({ error: code })
    }
  })

  app.post('/api/v1/dingtalk/artwork-source/sync', async (request, reply) => {
    const actor = await downstreamUser(request, reply, pool); if (!actor) return
    const current = await loadSource(pool, actor)
    if (!current) return reply.code(404).send({ error: 'artwork_source_not_bound' })
    try {
      const indexed = await resolveAndStore(pool, drive, actor, current.folder_url, current.node_id)
      return reply.header('cache-control', 'no-store').send({ source: publicSource(indexed) })
    } catch (error) {
      const code = error instanceof DingTalkDriveError ? error.code : 'dingtalk_drive_failure'
      await pool.query(`UPDATE artwork_sources SET status='error',last_error=$3,updated_at=now() WHERE organization_id=$1 AND user_id=$2`, [actor.organization_id, actor.id, code])
      return reply.code(502).send({ error: code })
    }
  })

  app.get('/api/v1/dingtalk/artwork-source/entries', async (request, reply) => {
    const actor = await downstreamUser(request, reply, pool); if (!actor) return
    const input = searchSchema.safeParse(request.query)
    if (!input.success) return reply.code(400).send({ error: 'invalid_artwork_search' })
    const source = await loadSource(pool, actor)
    if (!source) return reply.code(404).send({ error: 'artwork_source_not_bound' })
    const result = await pool.query<EntryRow>(
      `SELECT dentry_id,parent_id,name,entry_type,extension,size_bytes,version,path,modified_at
       FROM artwork_entries WHERE source_id=$1 AND ($2='' OR name ILIKE '%' || $2 || '%')
       ORDER BY CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,name LIMIT $3`,
      [source.id, input.data.query, input.data.limit]
    )
    return reply.header('cache-control', 'no-store').send({ entries: result.rows.map(publicEntry) })
  })
}

async function downstreamUser(request: Parameters<typeof authenticatedUser>[0], reply: Parameters<typeof authenticatedUser>[1], pool: pg.Pool): Promise<SessionUserRow | null> {
  const actor = await authenticatedUser(request, reply, pool)
  if (!actor) return null
  if (actor.business_role !== 'downstream') { await reply.code(403).send({ error: 'business_role_forbidden' }); return null }
  if (!actor.dingtalk_union_id) { await reply.code(409).send({ error: 'dingtalk_identity_incomplete' }); return null }
  return actor
}

async function resolveAndStore(pool: pg.Pool, drive: DingTalkDriveClient, actor: SessionUserRow, folderUrl: string, nodeId: string): Promise<SourceRow> {
  const resolved = await drive.resolvePersonalFolder(actor.dingtalk_union_id!, nodeId)
  const sourceId = randomUUID()
  const files = resolved.descendants.filter(entry => !['folder', 'FOLDER'].includes(entry.type))
  const folders = resolved.descendants.length - files.length
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const stored = await client.query<SourceRow>(
      `INSERT INTO artwork_sources(id,organization_id,user_id,folder_url,node_id,space_id,folder_name,status,file_count,folder_count,indexed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,now())
       ON CONFLICT(organization_id,user_id) DO UPDATE SET folder_url=EXCLUDED.folder_url,node_id=EXCLUDED.node_id,
         space_id=EXCLUDED.space_id,folder_name=EXCLUDED.folder_name,status='ready',file_count=EXCLUDED.file_count,
         folder_count=EXCLUDED.folder_count,last_error=NULL,indexed_at=now(),updated_at=now()
       RETURNING id,folder_url,node_id,space_id,folder_name,status,file_count,folder_count,last_error,indexed_at`,
      [sourceId, actor.organization_id, actor.id, folderUrl, nodeId, resolved.spaceId, resolved.folder.name, files.length, folders]
    )
    const actualId = stored.rows[0]!.id
    await client.query('DELETE FROM artwork_entries WHERE source_id=$1', [actualId])
    for (const entry of resolved.descendants) await insertEntry(client, actualId, actor, entry)
    await client.query('COMMIT')
    return stored.rows[0]!
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

async function insertEntry(client: pg.PoolClient, sourceId: string, actor: SessionUserRow, entry: DingTalkDentry): Promise<void> {
  await client.query(
    `INSERT INTO artwork_entries(source_id,organization_id,user_id,dentry_id,parent_id,name,entry_type,extension,size_bytes,version,path,modified_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [sourceId, actor.organization_id, actor.id, entry.id, entry.parentId, entry.name, entry.type, entry.extension, entry.size, entry.version, entry.path, entry.modifiedTime]
  )
}

async function loadSource(pool: pg.Pool, actor: SessionUserRow): Promise<SourceRow | null> {
  const found = await pool.query<SourceRow>(`SELECT id,folder_url,node_id,space_id,folder_name,status,file_count,folder_count,last_error,indexed_at FROM artwork_sources WHERE organization_id=$1 AND user_id=$2`, [actor.organization_id, actor.id])
  return found.rows[0] ?? null
}

function parseNodeId(value: string): string | null { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'alidocs.dingtalk.com' && /^\/i\/nodes\/[^/]+\/?$/.test(url.pathname) ? decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1)!) : null } catch { return null } }
function publicSource(row: SourceRow): object { return { folderUrl: row.folder_url, nodeId: row.node_id, spaceId: row.space_id, folderName: row.folder_name, status: row.status, fileCount: row.file_count, folderCount: row.folder_count, lastError: row.last_error, indexedAt: row.indexed_at?.toISOString() ?? null } }
function publicEntry(row: EntryRow): object { return { id: row.dentry_id, nodeUrl: `https://alidocs.dingtalk.com/i/nodes/${encodeURIComponent(row.dentry_id)}`, parentId: row.parent_id, name: row.name, type: row.entry_type, extension: row.extension, sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), version: row.version == null ? null : Number(row.version), path: row.path, modifiedAt: row.modified_at?.toISOString() ?? null } }
