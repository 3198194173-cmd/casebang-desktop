import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiSettingsSummary, ApplicationSettings, BaseFileKind, BaseFileUpdateRecord, SaveAiSettingsInput } from '@shared/contracts'

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
  version: 5
  baseFilePaths: Partial<Record<BaseFileKind, string>>
  baseFileUpdates: BaseFileUpdateRecord[]
  lastMasterImageDirectory: string | null
  materialMasterPath?: string | null
  application: ApplicationSettings
  cloudAi: PersistedCloudAiSettings
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

const EMPTY_SETTINGS: PersistedSettings = {
  version: 5,
  baseFilePaths: {},
  baseFileUpdates: [],
  lastMasterImageDirectory: null,
  application: DEFAULT_APPLICATION_SETTINGS,
  cloudAi: DEFAULT_CLOUD_AI
}

export class SettingsRepository {
  async getMaterialMasterPath(): Promise<string | null> { return (await this.read()).materialMasterPath ?? null }
  async setMaterialMasterPath(path: string): Promise<void> { const settings = await this.read(); settings.materialMasterPath = path; await this.write(settings) }
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
        version: 5,
        baseFilePaths: parsed.baseFilePaths ?? {},
        baseFileUpdates: parsed.baseFileUpdates ?? [],
        lastMasterImageDirectory: parsed.lastMasterImageDirectory ?? null,
        materialMasterPath: parsed.materialMasterPath ?? null,
        application: { ...DEFAULT_APPLICATION_SETTINGS, ...(parsed.application ?? {}) },
        cloudAi: { ...DEFAULT_CLOUD_AI, ...(parsed.cloudAi ?? {}) }
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
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，不能保存 API Key')
  return safeStorage.encryptString(apiKey).toString('base64')
}

function decryptApiKey(encrypted: string | null): string | null {
  if (!encrypted) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，不能读取 API Key')
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error('已保存的 API Key 无法解密，请重新填写')
  }
}
