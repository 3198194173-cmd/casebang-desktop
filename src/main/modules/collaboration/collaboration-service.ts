import { app, net, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CollaborationMember, CollaborationWorkAction, CollaborationWorkItem } from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import type { LifecycleService } from '@main/modules/lifecycle/lifecycle-service'
import { logger } from '@main/infrastructure/logger'
import { COLLABORATION_ORIGIN } from './collaboration-endpoint'

const MAX_WORKBOOK_SIZE = 64 * 1024 * 1024
const CHUNK_UPLOAD_TIMEOUT_MS = 90_000
const CHUNK_UPLOAD_ATTEMPTS = 3
const DIRECT_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000
const publishSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1).max(240),
  sourceWorkflow: z.enum(['new-series', 'new-products', 'new-models'])
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

interface MembersResponse { members?: CollaborationMember[] }
interface WorkItemsResponse { items?: CollaborationWorkItem[] }
interface MaterialMasterResponse { item?: CollaborationWorkItem | null }
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
  patternOverrides?: Array<{ key: string; detectedVariant: string | null; finalVariant: string }>
}
interface WebOfficeSessionResponse { editorUrl?: string }
interface RequestTiming { timeoutMs?: number; timeoutMessage?: string }

export class CollaborationService {
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

  async materialMaster(): Promise<CollaborationWorkItem | null> {
    const response = await this.request('/api/v1/collaboration/material-master')
    const body = await response.json() as MaterialMasterResponse
    return body.item ? { ...body.item, activities: body.item.activities ?? [] } : null
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
      const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/workbook`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new Error('服务端返回的工作簿为空。')
      await writeFile(destination, bytes, { flag: 'wx' })
    }
    const openError = await shell.openPath(destination)
    if (openError) throw new Error(`无法打开工作簿：${openError}`)
    return { path: destination }
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
    patternOverrides?: Array<{ key: string; detectedVariant: string | null; finalVariant: string }>
  }): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = z.object({
      workItemId: z.string().uuid(), title: z.string().trim().min(1).max(240),
      expectedVersion: z.number().int().positive(), expectedRevision: z.number().int().positive(),
      changeReason: z.string().trim().min(1).max(500).optional(),
      patternOverrides: z.array(z.object({ key: z.string().max(1000), detectedVariant: z.string().regex(/^[A-Z0-9]{2}$/).nullable(), finalVariant: z.string().regex(/^[A-Z0-9]{2}$/) }).strict()).max(200).optional()
    }).strict().parse({
      workItemId: input.workItemId, title: input.title, expectedVersion: input.expectedVersion, expectedRevision: input.expectedRevision,
      changeReason: input.changeReason, patternOverrides: input.patternOverrides
    })
    if (!input.bytes.length || input.bytes.length > MAX_WORKBOOK_SIZE) throw new Error('要保存的共享工作簿为空或超过 64 MB。')
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    return this.uploadWorkbook(input.bytes, {
      sourceWorkflow: 'manual', sourceId: value.workItemId, title: value.title,
      sha256, requestKey: randomUUID(), targetWorkItemId: value.workItemId,
      expectedVersion: value.expectedVersion, expectedRevision: value.expectedRevision,
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
    const signal = AbortSignal.timeout(timeoutMs)
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
      if (signal.aborted && timing.timeoutMessage) throw new Error(timing.timeoutMessage)
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
    weboffice_disabled: 'WPS 在线编辑尚未启用，请先完成服务端回调配置。'
  }
  return messages[code ?? ''] ?? `协同服务处理失败${status ? `（HTTP ${status}）` : ''}。`
}
