import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import COS from 'cos-nodejs-sdk-v5'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface CosStorageOptions {
  bucket: string
  region: string
  secretId: string
  secretKey: string
}

export interface StoredObjectInfo {
  size: number
  sha256?: string
}

export class PrivateStorage {
  private readonly cos?: COS

  constructor(readonly root: string, readonly cosOptions?: CosStorageOptions) {
    if (cosOptions) {
      this.cos = new COS({
        SecretId: cosOptions.secretId,
        SecretKey: cosOptions.secretKey,
        Protocol: 'https:',
        Timeout: 60_000,
        KeepAlive: true
      })
    }
  }

  get supportsDirectTransfer(): boolean { return Boolean(this.cos && this.cosOptions) }

  async initialize(): Promise<void> {
    if (this.cos) {
      await this.check()
      await this.migrateLocalObjects()
      await this.writeObject('system/storage-version', Buffer.from('casebang-private-storage-v2\n'))
      return
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, '.storage-version'), 'casebang-private-storage-v1\n', { flag: 'a', mode: 0o600 })
    await this.check()
  }

  async check(): Promise<void> {
    if (this.cos && this.cosOptions) {
      await this.cos.getBucket({ Bucket: this.cosOptions.bucket, Region: this.cosOptions.region, Prefix: 'system/', MaxKeys: 1 })
      return
    }
    await access(this.root, constants.R_OK | constants.W_OK)
  }

  async writeObject(key: string, content: Buffer, sha256?: string): Promise<void> {
    this.validateKey(key)
    if (this.cos && this.cosOptions) {
      await this.cos.putObject({
        Bucket: this.cosOptions.bucket,
        Region: this.cosOptions.region,
        Key: key,
        Body: content,
        ContentLength: content.length,
        ContentType: key.endsWith('.xlsx') ? XLSX_CONTENT_TYPE : 'application/octet-stream',
        ...(sha256 ? { 'x-cos-meta-sha256': sha256 } : {})
      })
      return
    }
    const target = this.resolveObject(key)
    const temporary = `${target}.${randomUUID()}.tmp`
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async readObject(key: string): Promise<Buffer> {
    this.validateKey(key)
    if (this.cos && this.cosOptions) {
      try {
        return (await this.cos.getObject({ Bucket: this.cosOptions.bucket, Region: this.cosOptions.region, Key: key })).Body
      } catch (error) {
        throw normalizeNotFound(error)
      }
    }
    return readFile(this.resolveObject(key))
  }

  async removeObject(key: string): Promise<void> {
    this.validateKey(key)
    if (this.cos && this.cosOptions) {
      await this.cos.deleteObject({ Bucket: this.cosOptions.bucket, Region: this.cosOptions.region, Key: key })
      return
    }
    await rm(this.resolveObject(key), { force: true })
  }

  async removeTree(key: string): Promise<void> {
    this.validateKey(key)
    if (this.cos && this.cosOptions) {
      let marker: string | undefined
      do {
        const result = await this.cos.getBucket({
          Bucket: this.cosOptions.bucket,
          Region: this.cosOptions.region,
          Prefix: `${key.replace(/\/$/, '')}/`,
          MaxKeys: 1000,
          ...(marker ? { Marker: marker } : {})
        })
        if (result.Contents.length) {
          await this.cos.deleteMultipleObject({
            Bucket: this.cosOptions.bucket,
            Region: this.cosOptions.region,
            Objects: result.Contents.map(object => ({ Key: object.Key })),
            Quiet: true
          })
        }
        marker = result.IsTruncated === 'true' ? result.NextMarker : undefined
      } while (marker)
      return
    }
    await rm(this.resolveObject(key), { recursive: true, force: true })
  }

  async objectInfo(key: string): Promise<StoredObjectInfo> {
    this.validateKey(key)
    if (this.cos && this.cosOptions) {
      try {
        const result = await this.cos.headObject({ Bucket: this.cosOptions.bucket, Region: this.cosOptions.region, Key: key })
        const size = Number(result.headers?.['content-length'])
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('COS 对象大小无效')
        const sha256 = result.headers?.['x-cos-meta-sha256']
        return { size, ...(typeof sha256 === 'string' ? { sha256: sha256.toLowerCase() } : {}) }
      } catch (error) {
        throw normalizeNotFound(error)
      }
    }
    return { size: (await stat(this.resolveObject(key))).size }
  }

  async objectSize(key: string): Promise<number> { return (await this.objectInfo(key)).size }

  createUploadUrl(key: string, expiresSeconds = 30 * 60): string {
    this.validateKey(key)
    if (!this.cos || !this.cosOptions) throw new Error('当前存储不支持直传')
    return this.cos.getObjectUrl({
      Bucket: this.cosOptions.bucket,
      Region: this.cosOptions.region,
      Key: key,
      Method: 'PUT',
      Sign: true,
      Expires: expiresSeconds,
      Protocol: 'https:'
    })
  }

  createDownloadUrl(key: string, expiresSeconds = 10 * 60): string {
    this.validateKey(key)
    if (!this.cos || !this.cosOptions) throw new Error('当前存储不支持直链下载')
    return this.cos.getObjectUrl({
      Bucket: this.cosOptions.bucket,
      Region: this.cosOptions.region,
      Key: key,
      Method: 'GET',
      Sign: true,
      Expires: expiresSeconds,
      Protocol: 'https:'
    })
  }

  resolveObject(key: string): string {
    this.validateKey(key)
    if (this.cos) throw new Error('COS 对象没有本地文件路径')
    const target = resolve(this.root, key)
    if (!target.startsWith(resolve(this.root) + sep)) throw new Error('存储对象越界')
    return target
  }

  private validateKey(key: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,220}$/.test(key)) throw new Error('非法存储对象键')
    if (key.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('非法存储对象键')
    }
  }

  private async migrateLocalObjects(): Promise<void> {
    const localRoot = resolve(this.root)
    try {
      await access(localRoot, constants.R_OK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const target = join(folder, entry.name)
        if (entry.isDirectory()) {
          await visit(target)
          continue
        }
        if (!entry.isFile() || entry.name === '.storage-version' || entry.name.endsWith('.tmp')) continue
        const key = relative(localRoot, target).split(sep).join('/')
        this.validateKey(key)
        try {
          await this.objectInfo(key)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await this.writeObject(key, await readFile(target))
      }
    }
    await visit(localRoot)
  }
}

export function normalizeNotFound(error: unknown): unknown {
  if (isCosNotFound(error)) {
    const normalized = new Error('存储对象不存在') as NodeJS.ErrnoException
    normalized.code = 'ENOENT'
    return normalized
  }
  return error
}

function isCosNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as Record<string, unknown>
  const nested = value.error && typeof value.error === 'object'
    ? value.error as Record<string, unknown>
    : undefined
  const code = String(value.code ?? nested?.Code ?? '')
  const statusCode = Number(value.statusCode ?? nested?.StatusCode)
  return statusCode === 404 || ['NoSuchKey', 'NoSuchResource', 'NotFound'].includes(code)
}
