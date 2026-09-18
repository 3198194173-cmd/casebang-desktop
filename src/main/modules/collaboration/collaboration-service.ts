import { app, net, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CollaborationMember, CollaborationWorkAction, CollaborationWorkItem } from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import type { LifecycleService } from '@main/modules/lifecycle/lifecycle-service'
import { COLLABORATION_ORIGIN } from './collaboration-endpoint'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_WORKBOOK_SIZE = 64 * 1024 * 1024
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
  state: z.enum(['PENDING_PROCESSING', 'PROCESSING', 'PENDING_ORIGIN_REVIEW', 'NEEDS_SOURCE_FIX', 'READY_TO_MERGE', 'COMPLETED']).optional(),
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
interface SubmitResponse { item?: CollaborationWorkItem; duplicate?: boolean; error?: string }
interface WebOfficeSessionResponse { editorUrl?: string }

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
    return body.items ?? []
  }

  async publishWorkbook(input: unknown): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = publishSchema.parse(input)
    if (!value.path.toLowerCase().endsWith('.xlsx')) throw new Error('共享工作簿必须是 .xlsx 文件。')
    const details = await stat(value.path)
    if (!details.isFile() || details.size === 0) throw new Error('要导入的工作簿不存在或内容为空。')
    if (details.size > MAX_WORKBOOK_SIZE) throw new Error('工作簿超过 64 MB，尚不能导入共享流程。')
    const bytes = await readFile(value.path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const metadata = Buffer.from(JSON.stringify({
      sourceWorkflow: value.sourceWorkflow,
      sourceId: sha256,
      title: value.title.toLowerCase().endsWith('.xlsx') ? value.title : `${value.title}.xlsx`,
      sha256,
      requestKey: randomUUID()
    })).toString('base64url')
    const response = await this.request('/api/v1/collaboration/work-items', {
      method: 'POST',
      headers: { 'content-type': XLSX_CONTENT_TYPE, 'x-casebang-metadata': metadata },
      body: bytes
    })
    const body = await response.json() as SubmitResponse
    if (!body.item) throw new Error(serverError(body.error))
    return { item: body.item, duplicate: body.duplicate ?? false }
  }

  async submitLifecycle(input: unknown, lifecycle: LifecycleService): Promise<{ item: CollaborationWorkItem; duplicate: boolean }> {
    const value = submitSchema.parse(input)
    const { draft, path } = await lifecycle.submissionSnapshot(value.draftId, value.expectedVersion)
    const session = await this.settings.getCollaborationSession()
    if (!session) throw new Error('请先登录钉钉账号。')
    if (draft.ownerUserId && draft.ownerUserId !== session.user.id) throw new Error('该本地工作簿属于另一登录账号，当前账号不能提交。')
    const bytes = await readFile(path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== draft.sourceHash) throw new Error('提交前工作簿校验失败，请重新导入。')
    const metadata = Buffer.from(JSON.stringify({
      assigneeId: value.assigneeId,
      sourceWorkflow: draft.source,
      sourceId: draft.id,
      title: draft.title,
      sha256,
      requestKey: randomUUID()
    })).toString('base64url')
    const response = await this.request('/api/v1/collaboration/work-items', {
      method: 'POST',
      headers: { 'content-type': XLSX_CONTENT_TYPE, 'x-casebang-metadata': metadata },
      body: bytes
    })
    const body = await response.json() as SubmitResponse
    if (!body.item) throw new Error(serverError(body.error))
    return { item: body.item, duplicate: body.duplicate ?? false }
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

  async openOnlineWorkbook(input: unknown): Promise<{ opened: true }> {
    const value = openOnlineSchema.parse(input)
    const response = await this.request(`/api/v1/collaboration/work-items/${value.workItemId}/weboffice-session`, { method: 'POST' })
    const body = await response.json() as WebOfficeSessionResponse
    if (!body.editorUrl?.startsWith(`${COLLABORATION_ORIGIN}/weboffice/editor?`)) throw new Error('在线编辑地址校验失败。')
    await shell.openExternal(body.editorUrl)
    return { opened: true }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const session = await this.settings.getCollaborationSession()
    if (!session) throw new Error('请先登录钉钉账号。')
    let response: Response
    try {
      response = await net.fetch(`${COLLABORATION_ORIGIN}${path}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${session.sessionToken}` },
        signal: AbortSignal.timeout(init.method === 'POST' ? 120_000 : 30_000)
      })
    } catch {
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
    invalid_action: '任务操作参数不正确，请刷新后重试。',
    stage_required: '请选择要保存的工作簿阶段。',
    return_reason_required: '退回任务必须填写原因。',
    forbidden_action: '当前账号不是这个任务的处理人。',
    version_conflict: '任务版本已经更新，请刷新任务后重试。',
    state_conflict: '任务状态已经变化，请刷新任务后重试。',
    idempotency_conflict: '任务操作标识冲突，请刷新后重新操作。',
    work_item_not_found: '没有找到该工作簿记录。',
    business_role_forbidden: '当前账号不能执行此操作。',
    weboffice_disabled: 'WPS 在线编辑尚未启用，请先完成服务端回调配置。'
  }
  return messages[code ?? ''] ?? `协同服务处理失败${status ? `（HTTP ${status}）` : ''}。`
}
