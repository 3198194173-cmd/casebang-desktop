import { app, dialog, net, session as electronSession, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CollaborationActivity, CollaborationMember, CollaborationWorkAction, CollaborationWorkItem, DingTalkArtworkEntry, DingTalkArtworkSource, DingTalkArtworkTarget, LocalWorkbookEditSession } from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import type { LifecycleService } from '@main/modules/lifecycle/lifecycle-service'
import { logger } from '@main/infrastructure/logger'
import { COLLABORATION_ORIGIN } from './collaboration-endpoint'
import { readOoxmlParts } from '@main/modules/spreadsheet/ooxml-package'

const MAX_WORKBOOK_SIZE = 64 * 1024 * 1024
const CHUNK_UPLOAD_TIMEOUT_MS = 90_000
const CHUNK_UPLOAD_ATTEMPTS = 3
const DIRECT_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000
const MAX_ARTWORK_PDF_SIZE = 16 * 1024 * 1024
const ARTWORK_DOWNLOAD_TIMEOUT_MS = 120_000
const artworkTicketSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  version: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable()
})
const publishSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1).max(240),
  sourceWorkflow: z.enum(['new-series', 'new-products', 'new-models', 'manual'])
}).strict()
const submitSchema = z.object({
  draftId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  assigneeId: z.string().uuid()
}).strict()
const actionSchema = z.object({
  workItemId: z.string().uuid(),
  action: z.enum(['claim', 'return-source', 'update-stage']),
  expectedVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  state: z.enum(['PENDING_PROCESSING', 'PROCESSING', 'PENDING_ORIGIN_REVIEW', 'NEEDS_SOURCE_FIX', 'READY_TO_MERGE', 'COMPLETED', 'CANCELLED']).optional(),
  reason: z.string().trim().max(1_000).optional()
}).strict()
const openSchema = z.object({
  workItemId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  revision: z.number().int().positive()
}).strict()
const openOnlineSchema = z.object({ workItemId: z.string().uuid() }).strict()
const localEditSchema = z.object({ workItemId: z.string().uuid() }).strict()
const localEditSessionSchema = localEditSchema.extend({ sessionId: z.string().uuid() }).strict()
const localEditManifestSchema = z.object({
  id: z.string().uuid(), workItemId: z.string().uuid(), userId: z.string().min(1),
  title: z.string().min(1), baseVersion: z.number().int().positive(),
  baseRevision: z.number().int().positive(), baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
}).strict()
type LocalEditManifest = z.infer<typeof localEditManifestSchema>
const workbookMetadataSchema = z.object({
  title: z.string().min(1), state: z.string(), version: z.number().int().positive(),
  revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
})

interface MembersResponse { members?: CollaborationMember[] }
interface WorkItemsResponse { items?: CollaborationWorkItem[] }
interface MaterialMasterResponse { item?: CollaborationWorkItem | null }
interface ArtworkSourceResponse { source?: DingTalkArtworkSource | null }
interface ArtworkEntriesResponse { entries?: DingTalkArtworkEntry[] }
interface ArtworkTargetResponse { target?: DingTalkArtworkTarget | null }
interface SubmitResponse { item?: CollaborationWorkItem; duplicate?: boolean; error?: string }
interface UploadPrepareResponse {
  uploadId?: string
  uploadMode?: 'direct' | 'chunked'
  uploadUrl?: string
  headers?: Record<string, string>
  expiresAt?: string
  chunkSize?: number
  totalChunks?: number
  error?: string
}
const uploadPrepareResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadMode: z.enum(['direct', 'chunked']).default('chunked'),
  uploadUrl: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
  chunkSize: z.number().int().positive().max(512 * 1024).optional(),
  totalChunks: z.number().int().positive().optional()
})
interface WorkbookUploadMetadata {
  assigneeId?: string
  sourceWorkflow: 'new-series' | 'new-products' | 'new-models' | 'manual'
  sourceId: string
  title: string
  sha256: string
  requestKey: string
  targetWorkItemId?: string
  expectedVersion?: number
  expectedRevision?: number
  changeReason?: string
  editMethod?: 'software' | 'local-manual'
  patternOverrides?: Array<{ key: string; detectedVariant: string | null; finalVariant: string }>
}
interface WebOfficeSessionResponse { editorUrl?: string }
interface RequestTiming { timeoutMs?: number; timeoutMessage?: string }

export class CollaborationService {
  private readonly artworkDownloads = new Map<string, Set<AbortController>>()
  private readonly localCommits = new Set<string>()
  constructor(private readonly settings: SettingsRepository) {}

  async members(): Promise<CollaborationMember[]> {
    const response = await this.request('/api/v1/collaboration/members')
    const body = await response.json() as MembersResponse
    return body.members ?? []
  }

  async workItems(): Promise<CollaborationWorkItem[]> {
    const response = await this.request('/api/v1/collaboration/work-items')
    const body = await response.json() as WorkItemsResponse
    return (body.items ?? []).map(item => ({ ...item, activities: item.activities ?? [] }))
  }

  async activities(input: unknown): Promise<{ activities: CollaborationActivity[]; nextBeforeVersion: number | null }> {
    const value = localEditSchema.extend({ beforeVersion: z.number().int().positive().optional() }).parse(input)
    const query = value.beforeVersion ? `?beforeVersion=${value.beforeVersion}` : ''
    const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/activities${query}`)
    return await response.json() as { activities: CollaborationActivity[]; nextBeforeVersion: number | null }
  }

  async materialMaster(): Promise<CollaborationWorkItem | null> {
    const response = await this.request('/api/v1/collaboration/material-master')
    const body = await response.json() as MaterialMasterResponse
    return body.item ? { ...body.item, activities: body.item.activities ?? [] } : null
  }

  async artworkSource(): Promise<DingTalkArtworkSource | null> {
    const response = await this.request('/api/v1/dingtalk/artwork-source')
    return ((await response.json()) as ArtworkSourceResponse).source ?? null
  }

  async bindArtworkSource(input: unknown): Promise<DingTalkArtworkSource> {
    const value = z.object({ folderUrl: z.string().url().max(1000) }).strict().parse(input)
    const response = await this.request('/api/v1/dingtalk/artwork-source', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
    }, { timeoutMs: 120_000, timeoutMessage: '钉盘目录索引超时，请稍后重试。' })
    const source = ((await response.json()) as ArtworkSourceResponse).source
    if (!source) throw new Error('钉盘没有返回目录绑定结果。')
    return source
  }

  async syncArtworkSource(): Promise<DingTalkArtworkSource> {
    const response = await this.request('/api/v1/dingtalk/artwork-source/sync', { method: 'POST' }, { timeoutMs: 120_000, timeoutMessage: '钉盘目录同步超时，请稍后重试。' })
    const source = ((await response.json()) as ArtworkSourceResponse).source
    if (!source) throw new Error('钉盘没有返回目录同步结果。')
    return source
  }

  async searchArtworkEntries(input: unknown): Promise<DingTalkArtworkEntry[]> {
    const value = z.object({ query: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(1000).optional(), workItemId: z.string().uuid().optional() }).strict().parse(input)
    const query = new URLSearchParams({ ...(value.query ? { query: value.query } : {}), ...(value.limit ? { limit: String(value.limit) } : {}), ...(value.workItemId ? { workItemId: value.workItemId } : {}) })
    const response = await this.request(`/api/v1/dingtalk/artwork-source/entries?${query}`)
    return ((await response.json()) as ArtworkEntriesResponse).entries ?? []
  }

  async artworkTarget(input: unknown): Promise<DingTalkArtworkTarget | null> {
    const value = z.object({ workItemId: z.string().uuid() }).strict().parse(input)
    const response = await this.request(`/api/v1/dingtalk/artwork-targets/${encodeURIComponent(value.workItemId)}`)
    return ((await response.json()) as ArtworkTargetResponse).target ?? null
  }

  async bindArtworkTarget(input: unknown): Promise<DingTalkArtworkTarget> {
    const value = z.object({ workItemId: z.string().uuid(), folderUrl: z.string().url().max(1000), categoryDentryId: z.string().trim().min(1).max(200).optional(), modelDentryId: z.string().trim().min(1).max(200).optional() }).strict().parse(input)
    const response = await this.request(`/api/v1/dingtalk/artwork-targets/${encodeURIComponent(value.workItemId)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderUrl: value.folderUrl, ...(value.categoryDentryId ? { categoryDentryId: value.categoryDentryId } : {}), ...(value.modelDentryId ? { modelDentryId: value.modelDentryId } : {}) })
    })
    const target = ((await response.json()) as ArtworkTargetResponse).target
    if (!target) throw new Error('钉盘没有返回系列目录绑定结果。')
    return target
  }

  async artworkPdf(input: unknown): Promise<{ dataUrl: string; version: number | null }> {
    const value = z.object({ workItemId: z.string().uuid(), dentryId: z.string().min(1).max(200), scopeId: z.string().uuid() }).strict().parse(input)
    const controller = new AbortController()
    const active = this.artworkDownloads.get(value.scopeId) ?? new Set<AbortController>()
    active.add(controller)
    this.artworkDownloads.set(value.scopeId, active)
    const timeout = AbortSignal.timeout(ARTWORK_DOWNLOAD_TIMEOUT_MS)
    const signal = AbortSignal.any([controller.signal, timeout])
    try {
      const ticketResponse = await this.request(
        `/api/v1/dingtalk/artwork-targets/${encodeURIComponent(value.workItemId)}/pdfs/${encodeURIComponent(value.dentryId)}/download-ticket`,
        { cache: 'no-store', signal: controller.signal },
        { timeoutMs: 30_000, timeoutMessage: '钉钉 PDF 下载凭证获取超时，请重试。' }
      )
      const ticket = artworkTicketSchema.parse(await ticketResponse.json())
      const resource = new URL(ticket.url)
      if (resource.protocol !== 'https:' || resource.username || resource.password || (resource.port && resource.port !== '443') || !/(^|\.)(aliyuncs\.com|dingtalk\.com)$/.test(resource.hostname)) {
        throw new Error('钉钉返回了不受信任的 PDF 下载地址。')
      }
      if (ticket.sizeBytes != null && ticket.sizeBytes > MAX_ARTWORK_PDF_SIZE) throw new Error('PDF 超过 16 MB，暂不支持自动核验。')
      // A non-persistent session with HTTP caching disabled keeps the signed
      // download out of the app's on-disk cache and away from the renderer.
      const previewSession = electronSession.fromPartition('casebang-artwork-preview', { cache: false })
      const response = await previewSession.fetch(resource.toString(), {
        headers: ticket.headers, redirect: 'error', cache: 'no-store', signal
      })
      if (!response.ok) throw new Error(`钉钉 PDF 下载失败（HTTP ${response.status}）。`)
      if (Number(response.headers.get('content-length') ?? '0') > MAX_ARTWORK_PDF_SIZE) throw new Error('PDF 超过 16 MB，暂不支持自动核验。')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('钉钉未返回 PDF 内容。')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > MAX_ARTWORK_PDF_SIZE) throw new Error('PDF 超过 16 MB，暂不支持自动核验。')
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      const bytes = Buffer.concat(chunks)
      if (ticket.sizeBytes != null && bytes.length !== ticket.sizeBytes) throw new Error('PDF 下载不完整，请重试。')
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('钉钉返回的内容不是 PDF 文件。')
      return { dataUrl: `data:application/pdf;base64,${bytes.toString('base64')}`, version: ticket.version }
    } catch (reason) {
      if (controller.signal.aborted) throw new Error('PDF 下载已取消。')
      if (timeout.aborted) throw new Error('电脑直连钉钉下载 PDF 超过 2 分钟，请检查本机网络后重试。')
      if (reason instanceof Error && (reason.message.startsWith('钉钉') || reason.message.startsWith('PDF ') || reason.message.startsWith('协同服务'))) throw reason
      throw new Error(`电脑直连钉钉下载 PDF 失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      active.delete(controller)
      if (!active.size && this.artworkDownloads.get(value.scopeId) === active) this.artworkDownloads.delete(value.scopeId)
    }
  }

  cancelArtworkPdf(input: unknown): void {
    const { scopeId } = z.object({ scopeId: z.string().uuid() }).strict().parse(input)
    const active = this.artworkDownloads.get(scopeId)
    if (!active) return
    this.artworkDownloads.delete(scopeId)
    for (const controller of active) controller.abort()
  }

  async publishMaterialMaster(): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const masterPath = await this.settings.getMaterialMasterPath()
    if (!masterPath) throw new Error('请先在资料管理中选择物料总表。')
    const details = await stat(masterPath)
    if (!details.isFile() || details.size === 0 || details.size > MAX_WORKBOOK_SIZE) throw new Error('物料总表不存在、为空或超过 64 MB。')
    const bytes = await readFile(masterPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const current = await this.materialMaster()
    return this.uploadWorkbook(bytes, {
      sourceWorkflow: 'manual', sourceId: 'material-master', title: path.basename(masterPath), sha256, requestKey: randomUUID(),
      ...(current ? { targetWorkItemId: current.id, expectedVersion: current.version, expectedRevision: current.revision, changeReason: '软件同步物料总表' } : {})
    }, path.basename(masterPath))
  }

  async syncMaterialMaster(): Promise<{ item: CollaborationWorkItem; path: string }> {
    const item = await this.materialMaster()
    if (!item) throw new Error('中央尚未建立共享物料总表，请先在资料管理中上传。')
    const bytes = await this.downloadWorkbook({ workItemId: item.id })
    const directory = path.join(app.getPath('userData'), 'shared-material-master')
    const safeTitle = item.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    const destination = path.join(directory, `revision-${item.revision}-${safeTitle.toLowerCase().endsWith('.xlsx') ? safeTitle : `${safeTitle}.xlsx`}`)
    await mkdir(directory, { recursive: true })
    if (!await access(destination).then(() => true).catch(() => false)) await writeFile(destination, bytes, { flag: 'wx' })
    await this.settings.setMaterialMasterPath(destination)
    return { item, path: destination }
  }

  async publishWorkbook(input: unknown): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = publishSchema.parse(input)
    if (!value.path.toLowerCase().endsWith('.xlsx')) throw new Error('共享工作簿必须是 .xlsx 文件。')
    const details = await stat(value.path)
    if (!details.isFile() || details.size === 0) throw new Error('要导入的工作簿不存在或内容为空。')
    if (details.size > MAX_WORKBOOK_SIZE) throw new Error('工作簿超过 64 MB，尚不能导入共享流程。')
    const bytes = await readFile(value.path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const metadata: WorkbookUploadMetadata = {
      sourceWorkflow: value.sourceWorkflow,
      sourceId: sha256,
      title: value.title.toLowerCase().endsWith('.xlsx') ? value.title : `${value.title}.xlsx`,
      sha256,
      requestKey: randomUUID()
    }
    return this.uploadWorkbook(bytes, metadata, path.basename(value.path))
  }

  async submitLifecycle(input: unknown, lifecycle: LifecycleService): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = submitSchema.parse(input)
    const { draft, path: workbookPath } = await lifecycle.submissionSnapshot(value.draftId, value.expectedVersion)
    const session = await this.settings.getCollaborationSession()
    if (!session) throw new Error('请先登录钉钉账号。')
    if (draft.ownerUserId && draft.ownerUserId !== session.user.id) throw new Error('该本地工作簿属于另一登录账号，当前账号不能提交。')
    const bytes = await readFile(workbookPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== draft.sourceHash) throw new Error('提交前工作簿校验失败，请重新导入。')
    const metadata: WorkbookUploadMetadata = {
      assigneeId: value.assigneeId,
      sourceWorkflow: draft.source,
      sourceId: draft.id,
      title: draft.title,
      sha256,
      requestKey: randomUUID()
    }
    return this.uploadWorkbook(bytes, metadata, path.basename(workbookPath))
  }

  async act(input: unknown): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = actionSchema.parse(input)
    const requestKey = randomUUID()
    const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: value.action satisfies CollaborationWorkAction,
        expectedVersion: value.expectedVersion,
        revision: value.revision,
        ...(value.state ? { state: value.state } : {}),
        requestKey,
        ...(value.reason ? { reason: value.reason } : {})
      })
    })
    const body = await response.json() as SubmitResponse
    if (!body.item) throw new Error(serverError(body.error))
    return { item: body.item, duplicate: body.duplicate ?? false }
  }

  async openWorkbook(input: unknown): Promise<{ path: string }> {
    const value = openSchema.parse(input)
    const safeTitle = value.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    const directory = path.join(app.getPath('userData'), 'collaboration-workbooks', value.workItemId)
    const fileName = safeTitle.toLowerCase().endsWith('.xlsx') ? safeTitle : `${safeTitle}.xlsx`
    const destination = path.join(directory, `revision-${value.revision}-${fileName}`)
    await mkdir(directory, { recursive: true })
    const exists = await access(destination).then(() => true).catch(() => false)
    if (!exists) {
      const metadataResponse = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/workbook-metadata`)
      const metadata = workbookMetadataSchema.parse(await metadataResponse.json())
      if (metadata.revision !== value.revision) throw new Error('中央修订已变化，请刷新工作簿记录后重试。')
      const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/workbook?revision=${value.revision}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || sha256(bytes) !== metadata.sha256) throw new Error('服务端返回的工作簿与中央修订摘要不符。')
      await writeFile(destination, bytes, { flag: 'wx' })
    }
    const openError = await shell.openPath(destination)
    if (openError) throw new Error(`无法打开工作簿：${openError}`)
    return { path: destination }
  }

  async activeLocalEdit(input: unknown): Promise<LocalWorkbookEditSession | null> {
    const { workItemId } = localEditSchema.parse(input)
    const userId = await this.localUserId()
    const manifest = await this.readActiveLocalEdit(workItemId, userId)
    return manifest ? this.publicLocalEdit(manifest) : null
  }

  async localEditor(): Promise<string | null> { return this.settings.getLocalWorkbookEditorPath() }

  async selectLocalEditor(): Promise<string | null> {
    const selection = await dialog.showOpenDialog({
      title: '选择本机 WPS 或 Excel 程序',
      properties: ['openFile'],
      filters: [{ name: 'Windows 程序', extensions: ['exe'] }]
    })
    if (selection.canceled) return this.localEditor()
    const filePath = selection.filePaths[0]
    if (!filePath || path.extname(filePath).toLowerCase() !== '.exe' || !(await stat(filePath)).isFile()) {
      throw new Error('请选择已安装的 WPS 或 Excel 程序（.exe）。')
    }
    await this.settings.setLocalWorkbookEditorPath(filePath)
    return filePath
  }

  async clearLocalEditor(): Promise<void> { await this.settings.setLocalWorkbookEditorPath(null) }

  async beginLocalEdit(input: unknown): Promise<LocalWorkbookEditSession> {
    const { workItemId, forceNew } = localEditSchema.extend({ forceNew: z.boolean().optional() }).parse(input)
    const userId = await this.localUserId()
    const current = await this.readActiveLocalEdit(workItemId, userId)
    if (current && forceNew) throw new Error('已有本地编辑稿。请先关闭表格文档，并在 CASEBANG 点击“结束并清理”后下载中央最新版。')
    if (current) return this.openLocalEdit({ workItemId, sessionId: current.id })
    const metadataResponse = await this.request(`/api/v1/collaboration/work-items/${workItemId}/workbook-metadata`)
    const metadata = workbookMetadataSchema.parse(await metadataResponse.json())
    if (['COMPLETED', 'CANCELLED'].includes(metadata.state)) throw new Error('工作簿已经归档或作废，不能开始本地编辑。')
    const response = await this.request(`/api/v1/collaboration/work-items/${workItemId}/workbook?revision=${metadata.revision}`, {}, {
      timeoutMs: 120_000, timeoutMessage: '下载共享工作簿超时，请稍后重试。'
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_WORKBOOK_SIZE) throw new Error('共享工作簿为空或超过 64 MB。')
    if (sha256(bytes) !== metadata.sha256) throw new Error('下载的工作簿与中央修订摘要不符，请重试。')
    const manifest: LocalEditManifest = {
      id: randomUUID(), workItemId, userId, title: metadata.title,
      baseVersion: metadata.version, baseRevision: metadata.revision,
      baseSha256: metadata.sha256, createdAt: new Date().toISOString()
    }
    const directory = this.localEditDirectory(manifest)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'workbook.xlsx'), bytes, { flag: 'wx' })
    await this.validateLocalWorkbook(path.join(directory, 'workbook.xlsx'))
    await writeFile(path.join(directory, 'session.json'), JSON.stringify(manifest), { flag: 'wx' })
    await this.writeActiveLocalEdit(manifest)
    await this.launchLocalWorkbook(path.join(directory, 'workbook.xlsx'))
    return this.publicLocalEdit(manifest)
  }

  async openLocalEdit(input: unknown): Promise<LocalWorkbookEditSession> {
    const { workItemId, sessionId } = localEditSessionSchema.parse(input)
    const manifest = await this.requireLocalEdit(workItemId, sessionId)
    const filePath = path.join(this.localEditDirectory(manifest), 'workbook.xlsx')
    await stat(filePath)
    await this.launchLocalWorkbook(filePath)
    return this.publicLocalEdit(manifest)
  }

  async commitLocalEdit(input: unknown): Promise<{ item: CollaborationWorkItem | null; duplicate: boolean; unchanged: boolean; hasRemainingChanges: boolean }> {
    const value = localEditSessionSchema.extend({ changeReason: z.string().trim().min(1).max(500).optional() }).parse(input)
    const key = `${value.workItemId}:${value.sessionId}`
    if (this.localCommits.has(key)) throw new Error('这份本地稿正在提交，请等待结果。')
    this.localCommits.add(key)
    try {
      const manifest = await this.requireLocalEdit(value.workItemId, value.sessionId)
      const filePath = path.join(this.localEditDirectory(manifest), 'workbook.xlsx')
      const before = await stat(filePath)
      if (!before.isFile() || before.size === 0 || before.size > MAX_WORKBOOK_SIZE) throw new Error('本地工作簿为空或超过 64 MB。')
      const bytes = await readFile(filePath)
      await new Promise(resolve => setTimeout(resolve, 350))
      const after = await stat(filePath)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== sha256(await readFile(filePath))) {
        throw new Error('本地工作簿仍在保存中，请在 WPS 保存完成后重试。')
      }
      const digest = sha256(bytes)
      if (digest === manifest.baseSha256) return { item: null, duplicate: true, unchanged: true, hasRemainingChanges: false }
      const snapshotPath = path.join(this.localEditDirectory(manifest), `submission-${randomUUID()}.xlsx`)
      await writeFile(snapshotPath, bytes, { flag: 'wx' })
      try { await this.validateLocalWorkbook(snapshotPath) }
      finally { await unlink(snapshotPath).catch(() => undefined) }
      const saved = await this.saveWorkbookRevision({
        workItemId: manifest.workItemId, title: manifest.title,
        expectedVersion: manifest.baseVersion, expectedRevision: manifest.baseRevision,
        bytes, changeReason: value.changeReason, editMethod: 'local-manual'
      })
      const currentDigest = await readFile(filePath).then(sha256).catch(() => null)
      let hasRemainingChanges = currentDigest !== digest
      try {
        const updatedManifest = { ...manifest, baseVersion: saved.item.version, baseRevision: saved.item.revision, baseSha256: digest }
        const manifestPath = path.join(this.localEditDirectory(manifest), 'session.json')
        const temporaryPath = `${manifestPath}.tmp`
        await writeFile(temporaryPath, JSON.stringify(updatedManifest))
        await rename(temporaryPath, manifestPath)
      } catch (reason) {
        hasRemainingChanges = true
        logger.warn('Workbook saved centrally but local edit state could not be finalized', {
          workItemId: manifest.workItemId, error: reason instanceof Error ? reason.message : String(reason)
        })
      }
      return { item: saved.item, duplicate: saved.duplicate, unchanged: false, hasRemainingChanges }
    } finally {
      this.localCommits.delete(key)
    }
  }

  async endLocalEdit(input: unknown): Promise<{ closed: boolean; requiresDiscardConfirmation: boolean }> {
    const value = localEditSessionSchema.extend({ discardChanges: z.boolean().optional() }).parse(input)
    const key = `${value.workItemId}:${value.sessionId}`
    if (this.localCommits.has(key)) throw new Error('本地稿正在提交，完成后才能结束编辑。')
    this.localCommits.add(key)
    try {
      const manifest = await this.requireLocalEdit(value.workItemId, value.sessionId)
      const directory = await this.checkedLocalEditDirectory(manifest)
      const names = await readdir(directory)
      if (names.some(name => name !== 'workbook.xlsx' && name !== 'session.json')) {
        throw new Error('本地稿目录中还有表格软件生成的文件。请先关闭该工作簿，再重试清理。')
      }
      const filePath = path.join(directory, 'workbook.xlsx')
      const manifestPath = path.join(directory, 'session.json')
      if (!(await lstat(filePath)).isFile() || !(await lstat(manifestPath)).isFile()) {
        throw new Error('本地编辑会话文件不完整，未执行清理。')
      }
      const before = await stat(filePath)
      const digest = sha256(await readFile(filePath))
      await new Promise(resolve => setTimeout(resolve, 350))
      const after = await stat(filePath)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || digest !== sha256(await readFile(filePath))) {
        throw new Error('工作簿仍在保存中。请先关闭本地表格软件，再结束编辑。')
      }
      if (digest !== manifest.baseSha256 && !value.discardChanges) {
        return { closed: false, requiresDiscardConfirmation: true }
      }
      let workbookDeleted = false
      try {
        await unlink(filePath)
        workbookDeleted = true
        await unlink(manifestPath)
        await rmdir(directory)
      } catch (reason) {
        if (workbookDeleted) await unlink(this.localEditPointerPath(manifest.workItemId, manifest.userId)).catch(() => undefined)
        throw reason
      }
      await unlink(this.localEditPointerPath(manifest.workItemId, manifest.userId)).catch(reason => {
        logger.warn('Local workbook removed but active pointer cleanup failed', {
          workItemId: manifest.workItemId, error: reason instanceof Error ? reason.message : String(reason)
        })
      })
      return { closed: true, requiresDiscardConfirmation: false }
    } finally {
      this.localCommits.delete(key)
    }
  }

  private async checkedLocalEditDirectory(manifest: LocalEditManifest): Promise<string> {
    const userData = await realpath(app.getPath('userData'))
    const cacheRoot = await realpath(path.join(app.getPath('userData'), 'collaboration-workbooks'))
    const actualDirectory = await realpath(this.localEditDirectory(manifest))
    const expected = path.join(cacheRoot, manifest.workItemId, 'edit-sessions', sha256(Buffer.from(manifest.userId)).slice(0, 24), manifest.id)
    if (path.dirname(cacheRoot) !== userData || actualDirectory !== expected) {
      throw new Error('本地稿路径不在 CASEBANG 缓存目录中，已停止清理。')
    }
    return actualDirectory
  }

  private async localUserId(): Promise<string> {
    const current = await this.settings.getCollaborationSession()
    if (!current || Date.parse(current.expiresAt) <= Date.now()) throw new Error('请先登录钉钉账号。')
    return current.user.id
  }

  private localEditRoot(workItemId: string, userId: string): string {
    return path.join(app.getPath('userData'), 'collaboration-workbooks', workItemId, 'edit-sessions', sha256(Buffer.from(userId)).slice(0, 24))
  }

  private localEditPointerPath(workItemId: string, userId: string): string {
    return path.join(this.localEditRoot(workItemId, userId), 'active.json')
  }

  private localEditDirectory(manifest: LocalEditManifest): string {
    return path.join(this.localEditRoot(manifest.workItemId, manifest.userId), manifest.id)
  }

  private async readActiveLocalEdit(workItemId: string, userId: string): Promise<LocalEditManifest | null> {
    const pointer = await readFile(this.localEditPointerPath(workItemId, userId), 'utf8').catch((reason: NodeJS.ErrnoException) => {
      if (reason.code === 'ENOENT') return null
      throw reason
    })
    if (!pointer) return null
    const sessionId = z.object({ sessionId: z.string().uuid() }).parse(JSON.parse(pointer)).sessionId
    const file = path.join(this.localEditRoot(workItemId, userId), sessionId, 'session.json')
    const manifest = localEditManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    if (manifest.workItemId !== workItemId || manifest.userId !== userId || manifest.id !== sessionId) throw new Error('本地编辑会话与当前账号不匹配。')
    return manifest
  }

  private async requireLocalEdit(workItemId: string, sessionId: string): Promise<LocalEditManifest> {
    const manifest = await this.readActiveLocalEdit(workItemId, await this.localUserId())
    if (!manifest || manifest.id !== sessionId) throw new Error('本地编辑会话已失效，请重新打开工作簿记录。')
    return manifest
  }

  private async writeActiveLocalEdit(manifest: LocalEditManifest): Promise<void> {
    const pointerPath = this.localEditPointerPath(manifest.workItemId, manifest.userId)
    const temporary = `${pointerPath}.${manifest.id}.tmp`
    await writeFile(temporary, JSON.stringify({ sessionId: manifest.id }), { flag: 'wx' })
    await rename(temporary, pointerPath)
  }

  private async publicLocalEdit(manifest: LocalEditManifest): Promise<LocalWorkbookEditSession> {
    const filePath = path.join(this.localEditDirectory(manifest), 'workbook.xlsx')
    const hasChanges = sha256(await readFile(filePath)) !== manifest.baseSha256
    return { id: manifest.id, workItemId: manifest.workItemId, title: manifest.title, filePath,
      baseVersion: manifest.baseVersion, baseRevision: manifest.baseRevision, createdAt: manifest.createdAt, hasChanges }
  }

  private async validateLocalWorkbook(filePath: string): Promise<void> {
    await readOoxmlParts(filePath, ['[Content_Types].xml', 'xl/workbook.xml'])
  }

  private async launchLocalWorkbook(filePath: string): Promise<void> {
    const editorPath = await this.settings.getLocalWorkbookEditorPath()
    if (!editorPath) {
      const openError = await shell.openPath(filePath)
      if (openError) throw new Error(`本地稿已保存，但默认表格程序无法打开：${openError}`)
      return
    }
    if (!(await stat(editorPath).catch(() => null))?.isFile()) {
      throw new Error(`已选编辑器不存在：${editorPath}。请重新选择程序，或恢复系统默认程序。`)
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editorPath, [filePath], { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }

  async openLocalWorkbook(input: unknown): Promise<{ path: string }> {
    const value = z.object({ path: z.string().trim().min(1) }).strict().parse(input)
    const details = await stat(value.path)
    if (!details.isFile() || !value.path.toLowerCase().endsWith('.xlsx')) throw new Error('请选择有效的 .xlsx 工作簿。')
    const openError = await shell.openPath(value.path)
    if (openError) throw new Error(`无法打开工作簿：${openError}`)
    return { path: value.path }
  }

  async downloadWorkbook(input: { workItemId: string }): Promise<Buffer> {
    const value = z.object({ workItemId: z.string().uuid() }).strict().parse(input)
    const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/workbook`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_WORKBOOK_SIZE) throw new Error('服务端返回的共享工作簿为空或超过 64 MB。')
    return bytes
  }

  async saveWorkbookRevision(input: {
    workItemId: string; title: string; expectedVersion: number; expectedRevision: number; bytes: Buffer
    changeReason?: string
    editMethod?: 'software' | 'local-manual'
    patternOverrides?: Array<{ key: string; detectedVariant: string | null; finalVariant: string }>
  }): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = z.object({
      workItemId: z.string().uuid(), title: z.string().trim().min(1).max(240),
      expectedVersion: z.number().int().positive(), expectedRevision: z.number().int().positive(),
      changeReason: z.string().trim().min(1).max(500).optional(),
      editMethod: z.enum(['software', 'local-manual']).optional(),
      patternOverrides: z.array(z.object({ key: z.string().max(1000), detectedVariant: z.string().regex(/^[A-Z0-9]{2}$/).nullable(), finalVariant: z.string().regex(/^[A-Z0-9]{2}$/) }).strict()).max(200).optional()
    }).strict().parse({
      workItemId: input.workItemId, title: input.title, expectedVersion: input.expectedVersion, expectedRevision: input.expectedRevision,
      changeReason: input.changeReason, editMethod: input.editMethod, patternOverrides: input.patternOverrides
    })
    if (!input.bytes.length || input.bytes.length > MAX_WORKBOOK_SIZE) throw new Error('要保存的共享工作簿为空或超过 64 MB。')
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    return this.uploadWorkbook(input.bytes, {
      sourceWorkflow: 'manual', sourceId: value.workItemId, title: value.title,
      sha256, requestKey: randomUUID(), targetWorkItemId: value.workItemId,
      expectedVersion: value.expectedVersion, expectedRevision: value.expectedRevision,
      ...(value.editMethod ? { editMethod: value.editMethod } : {}),
      ...(value.changeReason ? { changeReason: value.changeReason } : {}),
      ...(value.patternOverrides?.length ? { patternOverrides: value.patternOverrides } : {})
    }, value.title)
  }

  async openOnlineWorkbook(input: unknown): Promise<{ opened: true }> {
    const value = openOnlineSchema.parse(input)
    const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/weboffice-session`, { method: 'POST' })
    const body = await response.json() as WebOfficeSessionResponse
    if (!body.editorUrl?.startsWith(`${COLLABORATION_ORIGIN}/weboffice/editor?`)) throw new Error('在线编辑地址校验失败。')
    await shell.openExternal(body.editorUrl)
    return { opened: true }
  }

  private async uploadWorkbook(
    bytes: Buffer,
    metadata: WorkbookUploadMetadata,
    fileName: string
  ): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    logger.info('Preparing shared workbook upload', { fileName, sizeBytes: bytes.length })
    const preparedResponse = await this.request('/api/v1/collaboration/workbook-uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...metadata, size: bytes.length })
    })
    const preparedBody = await preparedResponse.json() as UploadPrepareResponse
    const prepared = uploadPrepareResponseSchema.safeParse(preparedBody)
    if (!prepared.success) throw new Error(serverError(preparedBody.error ?? 'invalid_upload_response'))
    if (prepared.data.uploadMode === 'direct') {
      if (!prepared.data.uploadUrl?.startsWith('https://') || !prepared.data.headers) {
        throw new Error('协同服务返回的 COS 直传参数不正确，请更新服务器后重试。')
      }
      await this.uploadDirect(prepared.data.uploadUrl, prepared.data.headers, bytes)
      logger.info('Shared workbook uploaded directly to object storage', { fileName, sizeBytes: bytes.length })
    } else {
      if (!prepared.data.chunkSize || !prepared.data.totalChunks || prepared.data.totalChunks !== Math.ceil(bytes.length / prepared.data.chunkSize)) {
        throw new Error('协同服务返回的分块参数不正确，请更新服务器后重试。')
      }
      for (let index = 0; index < prepared.data.totalChunks; index += 1) {
        const start = index * prepared.data.chunkSize
        const chunk = bytes.subarray(start, Math.min(start + prepared.data.chunkSize, bytes.length))
        await this.uploadChunk(prepared.data.uploadId, index, chunk)
        logger.info('Shared workbook chunk uploaded', {
          fileName,
          chunk: index + 1,
          totalChunks: prepared.data.totalChunks
        })
      }
    }

    const completedResponse = await this.request(
      `/api/v1/collaboration/workbook-uploads/${prepared.data.uploadId}/complete`,
      { method: 'POST' },
      { timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS, timeoutMessage: '服务器合并工作簿超时，请稍后重试。' }
    )
    const completed = await completedResponse.json() as SubmitResponse
    if (!completed.item) throw new Error(serverError(completed.error))
    logger.info('Shared workbook upload completed', {
      workItemId: completed.item.id,
      sizeBytes: bytes.length,
      uploadMode: prepared.data.uploadMode,
      duplicate: completed.duplicate ?? false
    })
    return { item: completed.item, duplicate: completed.duplicate ?? false }
  }

  private async uploadDirect(url: string, headers: Record<string, string>, bytes: Buffer): Promise<void> {
    const signal = AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS)
    let response: Response
    try {
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      response = await net.fetch(url, { method: 'PUT', headers, body, signal })
    } catch (reason) {
      logger.warn('Direct object storage upload failed', {
        timedOut: signal.aborted,
        error: reason instanceof Error ? reason.message : String(reason)
      })
      throw new Error(signal.aborted ? '上传到腾讯云 COS 超时，请检查网络后重试。' : '无法上传到腾讯云 COS，请检查网络后重试。')
    }
    if (!response.ok) throw new Error(`腾讯云 COS 上传失败（HTTP ${response.status}）。`)
  }

  private async uploadChunk(uploadId: string, index: number, chunk: Buffer): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= CHUNK_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        await this.request(
          `/api/v1/collaboration/workbook-uploads/${uploadId}/chunks/${index}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: chunk.toString('base64') })
          },
          { timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS, timeoutMessage: `工作簿第 ${index + 1} 个分块上传超时。` }
        )
        return
      } catch (error) {
        lastError = error
        logger.warn('Shared workbook chunk upload failed', {
          uploadId,
          chunk: index + 1,
          attempt,
          error: error instanceof Error ? error.message : String(error)
        })
        if (attempt < CHUNK_UPLOAD_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, attempt * 500))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('工作簿分块上传失败，请重试。')
  }

  private async request(path: string, init: RequestInit = {}, timing: RequestTiming = {}): Promise<Response> {
    const session = await this.settings.getCollaborationSession()
    if (!session) throw new Error('请先登录钉钉账号。')
    let response: Response
    const timeoutMs = timing.timeoutMs ?? (init.method === 'POST' ? 120_000 : 30_000)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      response = await net.fetch(`${COLLABORATION_ORIGIN}${path}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${session.sessionToken}` },
        signal
      })
    } catch (reason) {
      logger.warn('Collaboration request failed', {
        method: init.method ?? 'GET',
        path,
        timeoutMs,
        timedOut: signal.aborted,
        error: reason instanceof Error ? reason.message : String(reason)
      })
      if (init.signal?.aborted) throw new Error('PDF 下载已取消。')
      if (timeout.aborted && timing.timeoutMessage) throw new Error(timing.timeoutMessage)
      throw new Error('无法连接协同服务，请检查网络后重试。')
    }
    if (response.status === 401) {
      await this.settings.clearCollaborationSession()
      throw new Error('登录已失效，请重新登录。')
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(serverError(body.error, response.status))
    }
    return response
  }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

function serverError(code?: string, status?: number): string {
  const messages: Record<string, string> = {
    invalid_assignee: '接收人无效，请刷新成员列表后重试。',
    downstream_member_required: '尚未找到已登录的下游账号，请先让下游账号登录一次。',
    source_already_submitted: '该工作簿已经提交，不能改派给其他账号。',
    workbook_hash_mismatch: '上传后的工作簿校验不一致，请重试。',
    workbook_required: '没有读取到需要交接的工作簿。',
    invalid_upload_request: '工作簿上传参数不正确，请更新桌面端和服务器后重试。',
    invalid_upload_chunk: '工作簿分块编号不正确，请重新建立共享工作簿。',
    upload_not_found: '本次工作簿上传已过期，请重新建立共享工作簿。',
    upload_incomplete: '工作簿尚未完整上传，请重试。',
    upload_chunk_size_mismatch: '工作簿分块校验失败，请重新上传。',
    invalid_action: '任务操作参数不正确，请刷新后重试。',
    stage_required: '请选择要保存的工作簿阶段。',
    return_reason_required: '退回任务必须填写原因。',
    forbidden_action: '当前账号不是这个共享工作簿的参与人。',
    version_conflict: '任务版本已经更新，请刷新任务后重试。',
    state_conflict: '任务状态已经变化，请刷新任务后重试。',
    idempotency_conflict: '任务操作标识冲突，请刷新后重新操作。',
    work_item_not_found: '没有找到该工作簿记录。',
    business_role_forbidden: '当前账号不能执行此操作。',
    weboffice_disabled: 'WPS 在线编辑尚未启用，请先完成服务端回调配置。',
    invalid_artwork_source: '请输入有效的钉盘组织空间文件夹链接。',
    artwork_source_not_folder: '该链接对应的不是钉盘文件夹。',
    artwork_source_unreadable: '当前登录账号无法读取该钉盘目录，请确认链接属于可访问的组织空间并检查读取权限。',
    artwork_source_not_bound: '当前下游账号尚未绑定印刷图档目录。',
    dingtalk_identity_incomplete: '当前登录会话缺少钉钉用户标识，请退出后重新登录。',
    dingtalk_drive_failure: '钉盘接口调用失败，请检查应用的钉盘读取权限。',
  dingtalk_drive_permission_denied: '钉钉拒绝读取文件列表：当前接口明确要求应用权限 Storage.File.Read。除了开发者后台申请并发布，还需要由组织管理员在钉钉应用管理中完成增量授权；完成后重启中央服务并重新登录下游账号。Files.Read 不能替代该接口的应用权限。',
  dingtalk_personal_grant_required: '当前下游账号尚未完成个人钉盘授权，请退出后重新登录钉钉。',
  dingtalk_personal_token_refresh_failed: '个人钉盘授权已失效，请退出后重新登录钉钉授权。',
  dingtalk_personal_grant_corrupt: '个人钉盘授权凭据异常，请退出后重新登录钉钉授权。',
    dingtalk_drive_request_invalid: '钉盘个人空间请求参数不兼容，请先更新中央服务后重试。',
    dingtalk_token_missing: '钉钉应用访问令牌获取失败。',
    invalid_artwork_target: '请输入当前系列印刷图档文件夹的有效钉盘链接。',
    artwork_target_not_bound: '当前共享工作簿尚未选择系列印刷图档目录。',
    artwork_target_outside_source: '该系列目录不在当前账号绑定的固定父目录中，请先同步父目录索引。',
    artwork_target_not_indexed: '系列目录已解析，但没有找到可索引的目录节点。',
    artwork_category_not_indexed: '选择的产品类别目录不在当前系列索引中。',
    artwork_model_not_indexed: '选择的样本机型目录不在当前系列索引中。',
    artwork_target_not_folder: '当前系列链接对应的不是文件夹。',
    artwork_pdf_not_found: '该 PDF 不在当前工作簿已绑定的系列目录中，请重新读取目录。',
    artwork_pdf_too_large: '该 PDF 超过 16 MB，暂不支持自动图案核验。',
    dingtalk_pdf_too_large: '该 PDF 超过 16 MB，暂不支持自动图案核验。',
    dingtalk_download_unavailable: '钉钉未提供该 PDF 的下载信息，请检查文件权限。',
    dingtalk_download_untrusted: '钉钉返回了不受信任的下载地址，已中止自动核验。',
    dingtalk_download_not_pdf: '钉钉返回的文件内容不是 PDF，已中止自动核验。',
    dingtalk_download_failure: 'PDF 下载失败，请打开钉盘确认权限与文件状态。'
  }
  return messages[code ?? ''] ?? `协同服务处理失败${status ? `（HTTP ${status}）` : ''}。`
}
