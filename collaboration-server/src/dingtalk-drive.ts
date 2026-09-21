import type { ServerConfig } from './config.js'

const APP_TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const SPACES_ENDPOINT = 'https://api.dingtalk.com/v1.0/drive/spaces'

export interface DingTalkDentry {
  id: string
  uuid: string | null
  parentId: string | null
  name: string
  type: string
  extension: string | null
  size: number | null
  version: number | null
  path: string | null
  modifiedTime: string | null
}

export interface ResolvedArtworkFolder {
  spaceId: string
  folder: DingTalkDentry
  descendants: DingTalkDentry[]
}

export class DingTalkDriveError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DingTalkDriveError' }
}

export class DingTalkDriveClient {
  constructor(private readonly config: ServerConfig, private readonly fetcher: typeof fetch = fetch) {}

  async resolvePersonalFolder(unionId: string, nodeId: string): Promise<ResolvedArtworkFolder> {
    const token = await this.appToken()
    const spaces = await this.listSpaces(token, unionId)
    let lastFailure: DingTalkDriveError | null = null
    for (const space of spaces) {
      try {
        const entries = await this.listAll(token, unionId, space.id)
        const folder = entries.find(entry => entry.id === nodeId || entry.uuid === nodeId)
        if (!folder) continue
        if (!isFolder(folder.type)) throw new DingTalkDriveError('artwork_source_not_folder', '链接对应的不是钉盘文件夹。')
        const included = new Set([folder.id])
        let changed = true
        while (changed) {
          changed = false
          for (const entry of entries) {
            if (entry.parentId && included.has(entry.parentId) && !included.has(entry.id)) { included.add(entry.id); changed = true }
          }
        }
        return { spaceId: space.id, folder, descendants: entries.filter(entry => entry.id !== folder.id && included.has(entry.id)) }
      } catch (error) {
        if (error instanceof DingTalkDriveError && error.code === 'artwork_source_not_folder') throw error
        if (error instanceof DingTalkDriveError) lastFailure = error
      }
    }
    if (lastFailure) throw lastFailure
    throw new DingTalkDriveError('artwork_source_unreadable', '当前钉钉账号无法读取该个人目录，请确认链接属于当前登录账号并已申请钉盘读取权限。')
  }

  private async appToken(): Promise<string> {
    const body = await this.json<{ accessToken?: string }>(APP_TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: this.config.dingtalk.clientId, appSecret: this.config.dingtalk.clientSecret })
    })
    if (!body.accessToken) throw new DingTalkDriveError('dingtalk_token_missing', '钉钉未返回应用访问令牌。')
    return body.accessToken
  }

  private async listSpaces(token: string, unionId: string): Promise<Array<{ id: string }>> {
    const values: Array<{ id: string }> = []
    let nextToken = ''
    do {
      const url = new URL(SPACES_ENDPOINT)
      url.searchParams.set('unionId', unionId); url.searchParams.set('maxResults', '50')
      // DingTalk's public API calls the user's "My Documents" space `personal`.
      // `mySpace` is a product/CLI term and is rejected by this endpoint.
      url.searchParams.set('spaceType', 'personal')
      if (nextToken) url.searchParams.set('nextToken', nextToken)
      const body = await this.json<{ spaces?: Array<{ spaceId?: string }>; nextToken?: string }>(url, { headers: authHeaders(token) })
      values.push(...(body.spaces ?? []).flatMap(space => space.spaceId ? [{ id: space.spaceId }] : []))
      nextToken = body.nextToken ?? ''
    } while (nextToken)
    return values
  }

  private async listAll(token: string, unionId: string, spaceId: string): Promise<DingTalkDentry[]> {
    const values: DingTalkDentry[] = []
    let nextToken = ''
    do {
      const url = new URL(`https://api.dingtalk.com/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/listAll`)
      url.searchParams.set('unionId', unionId)
      const body = await this.json<{ dentries?: unknown; nextToken?: string }>(url, {
        method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ option: { maxResults: 100, ...(nextToken ? { nextToken } : {}), withThumbnail: false } })
      })
      for (const raw of asArray(body.dentries)) {
        const entry = normalizeDentry(raw)
        if (entry) values.push(entry)
      }
      nextToken = body.nextToken ?? ''
    } while (nextToken)
    return values
  }

  private async json<T>(url: string | URL, init: RequestInit): Promise<T> {
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) })
    const body = await response.json().catch(() => undefined) as (T & { code?: string; message?: string }) | undefined
    if (!response.ok || !body) {
      const remoteCode = body?.code ?? ''
      const code = ['permissionDenied', 'no.priviledge'].includes(remoteCode)
        ? 'dingtalk_drive_permission_denied'
        : remoteCode.toLowerCase().includes('param') ? 'dingtalk_drive_request_invalid' : 'dingtalk_drive_failure'
      throw new DingTalkDriveError(code, body?.message || `钉盘接口调用失败（HTTP ${response.status}）。`)
    }
    return body
  }
}

function authHeaders(token: string): Record<string, string> { return { 'x-acs-dingtalk-access-token': token } }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [] }
function text(value: unknown): string | null { return typeof value === 'string' && value ? value : null }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function isFolder(value: string): boolean { return ['folder', 'FOLDER'].includes(value) }
function normalizeDentry(value: unknown): DingTalkDentry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id) ?? text(raw.uuid)
  const name = text(raw.name)
  if (!id || !name) return null
  return {
    id, uuid: text(raw.uuid), parentId: text(raw.parentId), name, type: text(raw.type) ?? '', extension: text(raw.extension),
    size: number(raw.size), version: number(raw.version), path: text(raw.path), modifiedTime: text(raw.modifiedTime)
  }
}
