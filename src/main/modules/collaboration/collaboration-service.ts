import { net } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CollaborationMember, CollaborationWorkItem } from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import type { LifecycleService } from '@main/modules/lifecycle/lifecycle-service'

const SERVICE_ORIGIN = 'https://casebang.tech/collab'
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const submitSchema = z.object({
  draftId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  assigneeId: z.string().uuid()
}).strict()

interface MembersResponse { members?: CollaborationMember[] }
interface WorkItemsResponse { items?: CollaborationWorkItem[] }
interface SubmitResponse { item?: CollaborationWorkItem; duplicate?: boolean; error?: string }

export class CollaborationService {
  constructor(private readonly settings: SettingsRepository) {}

  async members(): Promise<CollaborationMember[]> {
    const response = await this.request('/api/v1/collaboration/members')
    const body = await response.json() as MembersResponse
    return body.members ?? []
  }

  async workItems(input: unknown): Promise<CollaborationWorkItem[]> {
    const box = z.enum(['inbox', 'sent']).parse(input)
    const response = await this.request(`/api/v1/collaboration/work-items?box=${box}`)
    const body = await response.json() as WorkItemsResponse
    return body.items ?? []
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

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const session = await this.settings.getCollaborationSession()
    if (!session) throw new Error('请先登录钉钉账号。')
    let response: Response
    try {
      response = await net.fetch(`${SERVICE_ORIGIN}${path}`, {
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
    source_already_submitted: '该工作簿已经提交，不能改派给其他账号。',
    workbook_hash_mismatch: '上传后的工作簿校验不一致，请重试。',
    workbook_required: '没有读取到需要交接的工作簿。'
  }
  return messages[code ?? ''] ?? `协同服务处理失败${status ? `（HTTP ${status}）` : ''}。`
}
