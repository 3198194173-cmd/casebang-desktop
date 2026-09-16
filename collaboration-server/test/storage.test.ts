import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PrivateStorage } from '../src/storage.js'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('private workbook storage', () => {
  it('initializes a writable private root and resolves controlled object keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'casebang-storage-')); temporary.push(root)
    const storage = new PrivateStorage(root)
    await storage.initialize()
    await expect(storage.check()).resolves.toBeUndefined()
    expect(storage.resolveObject('tenant/task/revision.xlsx')).toBe(join(root, 'tenant', 'task', 'revision.xlsx'))
  })
  it('rejects traversal, absolute paths, and invalid keys', () => {
    const storage = new PrivateStorage('C:/safe')
    for (const value of ['../secret', '/absolute', 'a/../../secret', 'a?.txt', 'a//b', '']) {
      expect(() => storage.resolveObject(value)).toThrow()
    }
  })
})
