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
  constructor(
    readonly code: string,
    message: string,
    readonly details: { operation?: string; httpStatus?: number; remoteCode?: string; requiredScopes?: string[] } = {}
  ) { super(message); this.name = 'DingTalkDriveError' }
}

export class DingTalkDriveClient {
  constructor(private readonly config: ServerConfig, private readonly fetcher: typeof fetch = fetch) {}

  async resolvePersonalFolder(unionId: string, nodeId: string): Promise<ResolvedArtworkFolder> {
    const token = await this.appToken()
    return this.resolveWithToken(token, unionId, nodeId)
  }

  async resolvePersonalFolderForUser(accessToken: string, unionId: string, nodeId: string): Promise<ResolvedArtworkFolder> {
    return this.resolveWithToken(accessToken, unionId, nodeId)
  }

  private async resolveWithToken(token: string, unionId: string, nodeId: string): Promise<ResolvedArtworkFolder> {
    const spaces = await this.listSpaces(token, unionId)
    let lastFailure: DingTalkDriveError | null = null
    for (const space of spaces) {
      try {
        // Resolve the copied folder link first. This is important for large
        // print-artwork directories: we must not enumerate the whole personal
        // space just to locate one series folder.
        const queriedFolder = await this.queryDentry(token, unionId, space.id, nodeId)
        if (queriedFolder) {
          if (!isFolder(queriedFolder.type)) throw new DingTalkDriveError('artwork_source_not_folder', '链接对应的不是钉盘文件夹。')
          const descendants = await this.listDescendants(token, unionId, space.id, queriedFolder.id)
          return { spaceId: space.id, folder: queriedFolder, descendants }
        }

        // Compatibility path for older tenants where the dentry query API is
        // unavailable. It is intentionally a fallback only; modern desktop
        // folder links take the bounded subtree path above.
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
    throw new DingTalkDriveError('artwork_source_unreadable', '当前钉钉账号无法读取该钉盘目录，请确认链接属于可访问的组织空间并已申请钉盘读取权限。')
  }

  private async listDescendants(token: string, unionId: string, spaceId: string, rootId: string): Promise<DingTalkDentry[]> {
    const values: DingTalkDentry[] = []
    const pendingParents = [rootId]
    while (pendingParents.length) {
      const parentId = pendingParents.shift()!
      let nextToken = ''
      do {
        const url = new URL(`https://api.dingtalk.com/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries`)
        url.searchParams.set('unionId', unionId)
        url.searchParams.set('parentId', parentId)
        url.searchParams.set('maxResults', '50')
        url.searchParams.set('withThumbnail', 'false')
        if (nextToken) url.searchParams.set('nextToken', nextToken)
        const body = await this.json<{ dentries?: unknown; nextToken?: string }>(url, { headers: authHeaders(token) }, 'list_dentries')
        for (const raw of asArray(body.dentries)) {
          const entry = normalizeDentry(raw)
          if (!entry) continue
          values.push(entry)
          if (isFolder(entry.type)) pendingParents.push(entry.id)
        }
        nextToken = body.nextToken ?? ''
      } while (nextToken)
    }
    return values
  }

  private async queryDentry(token: string, unionId: string, spaceId: string, dentryId: string): Promise<DingTalkDentry | null> {
    const url = new URL(`https://api.dingtalk.com/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/query`)
    url.searchParams.set('unionId', unionId)
    try {
      const body = await this.json<{ resultItems?: unknown[] }>(url, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ dentryIds: [dentryId], option: { withThumbnail: false } })
      }, 'query_dentry')
      const result = (body.resultItems ?? []).find(item => {
        if (!item || typeof item !== 'object') return false
        const raw = item as Record<string, unknown>
        return raw.dentryId === dentryId || raw.success === true
      })
      if (!result || typeof result !== 'object') return null
      const raw = result as Record<string, unknown>
      const nested = raw.dentry
      if (nested && typeof nested === 'object' && 'dentry' in nested) return normalizeDentry((nested as Record<string, unknown>).dentry)
      return normalizeDentry(nested ?? raw)
    } catch (error) {
      // A file that is not in this space is expected while trying multiple
      // spaces. Preserve permission failures so the caller can report them.
      if (error instanceof DingTalkDriveError && error.details.httpStatus === 404) return null
      if (error instanceof DingTalkDriveError && error.code === 'dingtalk_drive_request_invalid') return null
      // Some DingTalk tenants return HTTP 500/unknownError for a valid
      // desktop-folder node instead of returning a dentry. Treat that API
      // variant as “query unavailable” and use the existing listing fallback,
      // which can still resolve the folder by id/uuid.
      if (error instanceof DingTalkDriveError && /unsupported|not.?support|unknown.?error/i.test(`${error.details.remoteCode ?? ''} ${error.message}`)) return null
      throw error
    }
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
    const values = new Map<string, { id: string }>()
    let lastFailure: DingTalkDriveError | null = null
    // “My Documents” can be backed by either a personal space or the current
    // organization's drive. DingTalk may reject one space type while allowing
    // the other, so enumerate both independently and keep the accessible one.
    for (const spaceType of ['personal', 'org'] as const) {
      let nextToken = ''
      try {
        do {
          const url = new URL(SPACES_ENDPOINT)
          url.searchParams.set('unionId', unionId); url.searchParams.set('maxResults', '50')
          url.searchParams.set('spaceType', spaceType)
          if (nextToken) url.searchParams.set('nextToken', nextToken)
          const body = await this.json<{ spaces?: Array<{ spaceId?: string }>; nextToken?: string }>(url, { headers: authHeaders(token) }, `list_${spaceType}_spaces`)
          for (const space of body.spaces ?? []) if (space.spaceId) values.set(space.spaceId, { id: space.spaceId })
          nextToken = body.nextToken ?? ''
        } while (nextToken)
      } catch (error) {
        if (error instanceof DingTalkDriveError) { lastFailure = error; continue }
        throw error
      }
    }
    if (values.size) return [...values.values()]
    if (lastFailure) throw lastFailure
    return []
  }

  private async listAll(token: string, unionId: string, spaceId: string): Promise<DingTalkDentry[]> {
    try {
      return await this.listAllFlat(token, unionId, spaceId)
    } catch (error) {
      // listAll is an optional bulk endpoint. Some tenants grant the ordinary
      // child-list endpoint but deny listAll; fall back before reporting a
      // permission error so personal folders remain readable with least privilege.
      if (error instanceof DingTalkDriveError && error.code === 'dingtalk_drive_permission_denied' && error.details.operation !== 'list_all_dentries') throw error
      // Some DingTalk tenants do not expose listAll even though the ordinary
      // dentry-list API is available. Fall back to walking the folder tree.
      return this.listAllRecursively(token, unionId, spaceId)
    }
  }

  private async listAllFlat(token: string, unionId: string, spaceId: string): Promise<DingTalkDentry[]> {
    const values: DingTalkDentry[] = []
    let nextToken = ''
    do {
      const url = new URL(`https://api.dingtalk.com/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/listAll`)
      url.searchParams.set('unionId', unionId)
      const body = await this.json<{ dentries?: unknown; nextToken?: string }>(url, {
        method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ option: { maxResults: 50, ...(nextToken ? { nextToken } : {}), withThumbnail: false } })
      }, 'list_all_dentries')
      for (const raw of asArray(body.dentries)) {
        const entry = normalizeDentry(raw)
        if (entry) values.push(entry)
      }
      nextToken = body.nextToken ?? ''
    } while (nextToken)
    return values
  }

  private async listAllRecursively(token: string, unionId: string, spaceId: string): Promise<DingTalkDentry[]> {
    const values: DingTalkDentry[] = []
    const pendingParents = ['0']
    while (pendingParents.length) {
      const parentId = pendingParents.shift()!
      let nextToken = ''
      do {
        const url = new URL(`https://api.dingtalk.com/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries`)
        url.searchParams.set('unionId', unionId)
        url.searchParams.set('parentId', parentId)
        url.searchParams.set('maxResults', '50')
        url.searchParams.set('withThumbnail', 'false')
        if (nextToken) url.searchParams.set('nextToken', nextToken)
        const body = await this.json<{ dentries?: unknown; nextToken?: string }>(url, { headers: authHeaders(token) }, 'list_dentries')
        for (const raw of asArray(body.dentries)) {
          const entry = normalizeDentry(raw)
          if (!entry) continue
          values.push(entry)
          if (isFolder(entry.type)) pendingParents.push(entry.id)
        }
        nextToken = body.nextToken ?? ''
      } while (nextToken)
    }
    return values
  }

  private async json<T>(url: string | URL, init: RequestInit, operation = 'request'): Promise<T> {
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) })
    const body = await response.json().catch(() => undefined) as (T & { code?: string; message?: string; accessdenieddetail?: { requiredScopes?: string[] }; AccessDeniedDetail?: { requiredScopes?: string[] } }) | undefined
    if (!response.ok || !body) {
      const remoteCode = body?.code ?? ''
      const normalized = remoteCode.toLowerCase()
      const code = response.status === 401 || response.status === 403 || /permission|priviledge|privilege|forbidden|access.?denied/.test(normalized)
        ? 'dingtalk_drive_permission_denied'
        : response.status === 400 || /param|invalid/.test(normalized) ? 'dingtalk_drive_request_invalid' : 'dingtalk_drive_failure'
      throw new DingTalkDriveError(code, body?.message || `钉盘接口调用失败（HTTP ${response.status}）。`, {
        operation,
        httpStatus: response.status,
        remoteCode: remoteCode || undefined,
        requiredScopes: body?.accessdenieddetail?.requiredScopes ?? body?.AccessDeniedDetail?.requiredScopes
      })
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
  const id = text(raw.id) ?? text(raw.dentryId) ?? text(raw.fileId) ?? text(raw.uuid)
  const name = text(raw.name)
  if (!id || !name) return null
  return {
    id, uuid: text(raw.uuid) ?? text(raw.dentryUuid), parentId: text(raw.parentId), name, type: text(raw.type) ?? '', extension: text(raw.extension),
    size: number(raw.size), version: number(raw.version), path: text(raw.path), modifiedTime: text(raw.modifiedTime)
  }
}
