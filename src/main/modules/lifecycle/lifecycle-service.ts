import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { LifecycleDraft, LifecycleDraftSummary, LifecycleRowPreview } from '../../../shared/lifecycle-contracts'
import { patternVariantKey, previewMaterialCodes } from '../../../shared/material-coding'
import { readLifecycleWorkbook } from './workbook-reader'
import type { LifecycleRepository } from './lifecycle-repository'

export class LifecycleService {
  private repository: Promise<LifecycleRepository> | null = null
  private busy = false
  private root(): string { return join(app.getPath('userData'), 'material-lifecycle') }
  private repo(): Promise<LifecycleRepository> {
    if (!this.repository) this.repository = (async () => {
      await mkdir(this.root(), { recursive: true })
      // Load only when the new workflow is opened; legacy workflows stay independent.
      const { LifecycleRepository } = await import('./lifecycle-repository.js')
      return new LifecycleRepository(join(this.root(), 'preparation.sqlite'))
    })().catch(error => { this.repository = null; throw error })
    return this.repository
  }
  async list(): Promise<LifecycleDraftSummary[]> { return (await this.repo()).list() }
  async get(input: unknown): Promise<LifecycleDraft> { return (await this.repo()).get(z.string().uuid().parse(input)) }
  async preview(input: unknown): Promise<LifecycleRowPreview[]> { return previewMaterialCodes(await this.get(input)) }
  async save(input: unknown): Promise<LifecycleDraft> {
    const value = z.object({ id: z.string().uuid(), expectedVersion: z.number().int().positive(), barcodeSource: z.enum(['internal_monthly', 'platform']).nullable(),
      patternVariants: z.record(z.string().max(1000), z.string().regex(/^[A-Z0-9]{2}$/)).refine(values => Object.keys(values).length <= 2000) }).strict().parse(input)
    const repo = await this.repo()
    const keys = new Set(repo.get(value.id).rows.map(row => patternVariantKey(row.identity)))
    if (Object.keys(value.patternVariants).some(key => !keys.has(key))) throw new Error('标识不属于本任务')
    return repo.save(value.id, value.expectedVersion, value.barcodeSource, value.patternVariants)
  }
  async importWorkbook(): Promise<LifecycleDraft | null> {
    if (this.busy) throw new Error('正在导入，请稍候')
    this.busy = true
    let snapshot: string | null = null
    try {
      const selection = await dialog.showOpenDialog({ title: '选择上游生成的新建表格（不修改原文件）', properties: ['openFile'], filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] })
      const source = selection.filePaths[0]
      if (selection.canceled || !source) return null
      const info = await stat(source)
      if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('请选择 64 MB 以内的新建工作簿，不要导入整份物料总表或设计 PDF')
      const before = await hashFile(source)
      const repo = await this.repo()
      const existing = repo.findByHash(before)
      if (existing) return existing
      const id = randomUUID()
      await mkdir(join(this.root(), 'workbooks'), { recursive: true })
      snapshot = join(this.root(), 'workbooks', `${id}.xlsx`)
      await copyFile(source, snapshot, 1)
      const hash = await hashFile(snapshot)
      if (hash !== before || await hashFile(source) !== before) throw new Error('Excel 正在保存或文件已变化，请保存完成后重试')
      const parsed = await readLifecycleWorkbook(snapshot)
      const draft = repo.insert({ id, title: basename(source), source: 'manual', sourcePath: source, sourceHash: hash, createdAt: new Date().toISOString(), version: 1,
        rows: parsed.rows, warnings: parsed.warnings, barcodeSource: null, patternVariants: {} })
      if (draft.id !== id) await unlink(snapshot)
      snapshot = null
      return draft
    } finally {
      if (snapshot) await unlink(snapshot).catch(() => undefined)
      this.busy = false
    }
  }
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
