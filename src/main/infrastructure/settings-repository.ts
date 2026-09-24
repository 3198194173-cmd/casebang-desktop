import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiSettingsSummary, ApplicationSettings, BaseFileKind, BaseFileUpdateRecord, CollaborationUser, SaveAiSettingsInput } from '@shared/contracts'
import { MATERIAL_MODELS, mergeMaterialModels, type MaterialModel } from '@shared/material-model-dictionary'

export interface CloudAiSettings {
  provider: 'aliyun'
  model: string
  baseUrl: string
  apiKey: string | null
}

interface PersistedCloudAiSettings {
  provider: 'aliyun'
  model: string
  baseUrl: string
  encryptedApiKey: string | null
}

interface PersistedSettings {
  version: 6
  baseFilePaths: Partial<Record<BaseFileKind, string>>
  baseFileUpdates: BaseFileUpdateRecord[]
  lastMasterImageDirectory: string | null
  materialMasterPath?: string | null
  localWorkbookEditorPath?: string | null
  materialModels?: MaterialModel[]
  application: ApplicationSettings
  cloudAi: PersistedCloudAiSettings
  collaboration: PersistedCollaborationSession
}

interface PersistedCollaborationSession {
  encryptedSessionToken: string | null
  expiresAt: string | null
  user: CollaborationUser | null
}

export interface CollaborationSession {
  sessionToken: string
  expiresAt: string
  user: CollaborationUser
}

const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  autoSaveDrafts: true,
  requireQualityCheck: true,
  allowNetworkFeatures: true
}

const DEFAULT_CLOUD_AI: PersistedCloudAiSettings = {
  provider: 'aliyun',
  model: 'qwen3-vl-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  encryptedApiKey: null
}

const DEFAULT_COLLABORATION: PersistedCollaborationSession = {
  encryptedSessionToken: null,
  expiresAt: null,
  user: null
}

const EMPTY_SETTINGS: PersistedSettings = {
  version: 6,
  baseFilePaths: {},
  baseFileUpdates: [],
  lastMasterImageDirectory: null,
  application: DEFAULT_APPLICATION_SETTINGS,
  cloudAi: DEFAULT_CLOUD_AI,
  collaboration: DEFAULT_COLLABORATION
}

export class SettingsRepository {
  async getMaterialMasterPath(): Promise<string | null> { return (await this.read()).materialMasterPath ?? null }
  async setMaterialMasterPath(path: string): Promise<void> { const settings = await this.read(); settings.materialMasterPath = path; await this.write(settings) }
  async getLocalWorkbookEditorPath(): Promise<string | null> { return (await this.read()).localWorkbookEditorPath ?? null }
  async setLocalWorkbookEditorPath(filePath: string | null): Promise<void> { const settings = await this.read(); settings.localWorkbookEditorPath = filePath; await this.write(settings) }
  async getMaterialModels(): Promise<MaterialModel[]> {
    const values = (await this.read()).materialModels
    return structuredClone(values?.length ? mergeMaterialModels(values) : MATERIAL_MODELS)
  }
  async setMaterialModels(models: MaterialModel[]): Promise<void> {
    const settings = await this.read()
    settings.materialModels = structuredClone(models)
    await this.write(settings)
  }
  private readonly filePath: string

  constructor(filePath = join(app.getPath('userData'), 'settings.json')) {
    this.filePath = filePath
  }

  async getBaseFilePaths(): Promise<Partial<Record<BaseFileKind, string>>> {
    const settings = await this.read()
    return settings.baseFilePaths
  }

  async setBaseFilePath(kind: BaseFileKind, filePath: string): Promise<void> {
    const settings = await this.read()
    settings.baseFilePaths[kind] = filePath
    await this.write(settings)
  }

  async getLastMasterImageDirectory(): Promise<string | null> {
    return (await this.read()).lastMasterImageDirectory
  }

  async setLastMasterImageDirectory(directoryPath: string): Promise<void> {
    const settings = await this.read()
    settings.lastMasterImageDirectory = directoryPath
    await this.write(settings)
  }

  async getBaseFileUpdates(): Promise<BaseFileUpdateRecord[]> {
    return [...(await this.read()).baseFileUpdates].toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async addBaseFileUpdate(record: BaseFileUpdateRecord): Promise<void> {
    return this.addBaseFileUpdates([record])
  }

  async addBaseFileUpdates(records: BaseFileUpdateRecord[]): Promise<void> {
    const settings = await this.read()
    settings.baseFileUpdates.unshift(...records)
    settings.baseFileUpdates = settings.baseFileUpdates.slice(0, 200)
    await this.write(settings)
  }

  async markBaseFileUpdateRolledBack(recordId: string, rolledBackAt: string): Promise<BaseFileUpdateRecord> {
    const settings = await this.read()
    const record = settings.baseFileUpdates.find((item) => item.id === recordId)
    if (!record) throw new Error('找不到指定的覆盖记录')
    record.rolledBackAt = rolledBackAt
    await this.write(settings)
    return { ...record }
  }

  async getApplicationSettings(): Promise<ApplicationSettings> {
    return { ...(await this.read()).application }
  }

  async setApplicationSettings(input: ApplicationSettings): Promise<ApplicationSettings> {
    const settings = await this.read()
    settings.application = { ...input }
    await this.write(settings)
    return { ...settings.application }
  }

  async getCollaborationSession(): Promise<CollaborationSession | null> {
    const value = (await this.read()).collaboration
    if (!value.encryptedSessionToken || !value.expiresAt || !value.user) return null
    return {
      sessionToken: decryptSecret(value.encryptedSessionToken, '登录会话'),
      expiresAt: value.expiresAt,
      user: { ...value.user }
    }
  }

  async setCollaborationSession(input: CollaborationSession): Promise<void> {
    const settings = await this.read()
    settings.collaboration = {
      encryptedSessionToken: encryptSecret(input.sessionToken, '登录会话'),
      expiresAt: input.expiresAt,
      user: { ...input.user }
    }
    await this.write(settings)
  }

  async clearCollaborationSession(): Promise<void> {
    const settings = await this.read()
    settings.collaboration = { ...DEFAULT_COLLABORATION }
    await this.write(settings)
  }

  async getCloudAiSettings(): Promise<CloudAiSettings> {
    const settings = await this.read()
    return {
      provider: settings.cloudAi.provider,
      model: settings.cloudAi.model,
      baseUrl: settings.cloudAi.baseUrl,
      apiKey: decryptApiKey(settings.cloudAi.encryptedApiKey)
    }
  }

  async getAiSettingsSummary(): Promise<AiSettingsSummary> {
    return this.toCloudSummary(await this.read())
  }

  async getCloudAiSettingsSummary(): Promise<AiSettingsSummary> {
    return this.toCloudSummary(await this.read())
  }

  async setAiSettings(input: SaveAiSettingsInput): Promise<AiSettingsSummary> {
    const settings = await this.read()
    const nextKey = input.apiKey.trim()
    settings.cloudAi = {
      provider: 'aliyun',
      model: input.model.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      encryptedApiKey: nextKey ? encryptApiKey(nextKey) : settings.cloudAi.encryptedApiKey
    }
    await this.write(settings)
    return this.getAiSettingsSummary()
  }

  private async read(): Promise<PersistedSettings> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as Partial<PersistedSettings>
      return {
        version: 6,
        baseFilePaths: parsed.baseFilePaths ?? {},
        baseFileUpdates: parsed.baseFileUpdates ?? [],
        lastMasterImageDirectory: parsed.lastMasterImageDirectory ?? null,
        materialMasterPath: parsed.materialMasterPath ?? null,
        localWorkbookEditorPath: parsed.localWorkbookEditorPath ?? null,
        materialModels: Array.isArray(parsed.materialModels) ? parsed.materialModels : undefined,
        application: { ...DEFAULT_APPLICATION_SETTINGS, ...(parsed.application ?? {}) },
        cloudAi: { ...DEFAULT_CLOUD_AI, ...(parsed.cloudAi ?? {}) },
        collaboration: { ...DEFAULT_COLLABORATION, ...(parsed.collaboration ?? {}) }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      return structuredClone(EMPTY_SETTINGS)
    }
  }

  private async write(settings: PersistedSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8')
    await rename(temporaryPath, this.filePath)
  }

  private toCloudSummary(settings: PersistedSettings): AiSettingsSummary {
    const apiKey = decryptApiKey(settings.cloudAi.encryptedApiKey)
    return {
      provider: 'aliyun',
      model: settings.cloudAi.model,
      baseUrl: settings.cloudAi.baseUrl,
      configured: Boolean(apiKey),
      apiKeyPreview: apiKey ? `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}` : null
    }
  }

}

function encryptApiKey(apiKey: string): string {
  return encryptSecret(apiKey, 'API Key')
}

function decryptApiKey(encrypted: string | null): string | null {
  if (!encrypted) return null
  return decryptSecret(encrypted, 'API Key')
}

function encryptSecret(value: string, label: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(`Windows 安全存储当前不可用，不能保存${label}`)
  return safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(encrypted: string, label: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(`Windows 安全存储当前不可用，不能读取${label}`)
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error(`已保存的${label}无法解密，请重新登录或重新填写`)
  }
}
