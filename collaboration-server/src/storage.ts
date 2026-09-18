import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export class PrivateStorage {
  constructor(readonly root: string) {}
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, '.storage-version'), 'casebang-private-storage-v1\n', { flag: 'a', mode: 0o600 })
    await this.check()
  }
  async check(): Promise<void> { await access(this.root, constants.R_OK | constants.W_OK) }
  async writeObject(key: string, content: Buffer): Promise<void> {
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
  async readObject(key: string): Promise<Buffer> { return readFile(this.resolveObject(key)) }
  async removeObject(key: string): Promise<void> { await rm(this.resolveObject(key), { force: true }) }
  async removeTree(key: string): Promise<void> { await rm(this.resolveObject(key), { recursive: true, force: true }) }
  async objectSize(key: string): Promise<number> { return (await stat(this.resolveObject(key))).size }
  resolveObject(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,220}$/.test(key)) throw new Error('非法存储对象键')
    if (key.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('非法存储对象键')
    }
    const target = resolve(this.root, key)
    if (!target.startsWith(resolve(this.root) + sep)) throw new Error('存储对象越界')
    return target
  }
}
