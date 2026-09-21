import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { LifecycleDraft, LifecycleDraftSummary, LifecycleRowPreview, SharedLifecycleAnalysis } from '../../../shared/lifecycle-contracts'
import { internalBarcodeCandidate, patternVariantKey, previewMaterialCodes } from '../../../shared/material-coding'
import { readLifecycleWorkbook } from './workbook-reader'
import { inspectBarcodeSequence, writeLifecycleCells } from './workbook-allocator'
import type { LifecycleRepository } from './lifecycle-repository'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'

export class LifecycleService {
  private repository: Promise<LifecycleRepository> | null = null
  private busy = false
  constructor(private readonly settings: SettingsRepository) {}
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
  async analyzeSharedFile(
    input: { workItemId: string; title: string; version: number; revision: number; monthPrefix: string; patternVariants?: Record<string, string> },
    workbookPath: string
  ): Promise<SharedLifecycleAnalysis> {
    const masterPath = await this.settings.getMaterialMasterPath()
    if (!masterPath) throw new Error('请先选择最新的物料总表，再计算 69 码起始号码。')
    const parsed = await readLifecycleWorkbook(workbookPath)
    const variants = input.patternVariants ?? {}
    const materialCodePreviews = previewMaterialCodes({ rows: parsed.rows, patternVariants: variants })
    const master = await inspectBarcodeSequence(masterPath, input.monthPrefix)
    let maximumSequence = master.maximumSequence
    for (const row of parsed.rows) {
      const match = new RegExp(`^${input.monthPrefix}(\\d{7})$`).exec(row.barcode.trim())
      if (match) maximumSequence = Math.max(maximumSequence, Number(match[1]))
    }
    return {
      workItemId: input.workItemId,
      title: input.title,
      version: input.version,
      revision: input.revision,
      rows: parsed.rows,
      warnings: parsed.warnings,
      materialCodePreviews,
      barcodePlan: {
        monthPrefix: input.monthPrefix,
        previousCode: maximumSequence ? internalBarcodeCandidate(input.monthPrefix, maximumSequence) : null,
        nextCode: internalBarcodeCandidate(input.monthPrefix, maximumSequence + 1),
        pendingCount: parsed.rows.filter(row => !row.barcode.trim()).length,
        existingCount: parsed.rows.filter(row => row.barcode.trim()).length,
        masterFileName: master.masterFileName
      }
    }
  }
  async writeSharedFile(
    input: { workItemId: string; title: string; version: number; revision: number; monthPrefix: string; fillBarcodes: boolean; fillMaterialCodes: boolean; patternVariants: Record<string, string> },
    sourcePath: string,
    destinationPath: string
  ): Promise<{ barcodeFilled: number; materialCodeFilled: number }> {
    if (!input.fillBarcodes && !input.fillMaterialCodes) throw new Error('请至少选择填写 69 码或物料编码中的一项。')
    const analysis = await this.analyzeSharedFile(input, sourcePath)
    const writes = new Map<string, Array<{ address: string; value: string }>>()
    const add = (sheet: string, address: string, value: string): void => {
      const values = writes.get(sheet) ?? []
      values.push({ address, value }); writes.set(sheet, values)
    }
    let sequence = Number(analysis.barcodePlan.nextCode.slice(6))
    let barcodeFilled = 0
    let materialCodeFilled = 0
    const materialResults = new Map(analysis.materialCodePreviews.map(result => [result.rowId, result]))
    for (const row of analysis.rows) {
      if (input.fillBarcodes && !row.barcode.trim() && row.materialName.trim() && !row.issues.some(issue => issue.includes('业务字段含公式'))) {
        add(row.sheet, row.barcodeAddress, internalBarcodeCandidate(input.monthPrefix, sequence++))
        barcodeFilled += 1
      }
      const material = materialResults.get(row.id)
      if (input.fillMaterialCodes && !row.materialCode.trim() && material?.status === 'candidate' && material.candidate) {
        add(row.sheet, row.materialCodeAddress, material.candidate)
        materialCodeFilled += 1
      }
    }
    if (input.fillBarcodes && barcodeFilled === 0 && analysis.barcodePlan.pendingCount > 0) throw new Error('待填写的 69 码行含公式或缺少物料名称，未自动覆盖，请先人工核实。')
    if (input.fillMaterialCodes && materialCodeFilled === 0 && analysis.rows.some(row => !row.materialCode.trim())) throw new Error('没有可安全写入的物料编码；请先确认图案标识和机型映射。')
    await writeLifecycleCells(sourcePath, destinationPath, writes)
    return { barcodeFilled, materialCodeFilled }
  }
  async submissionSnapshot(id: string, expectedVersion: number): Promise<{ draft: LifecycleDraft; path: string }> {
    const draft = await this.get(id)
    if (draft.version !== expectedVersion) throw new Error('草稿已更新，请重新打开后再提交。')
    const path = join(this.root(), 'workbooks', `${draft.id}.xlsx`)
    const info = await stat(path)
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('任务工作簿不存在或超过 64 MB。')
    if (await hashFile(path) !== draft.sourceHash) throw new Error('任务工作簿快照校验失败，请重新导入。')
    return { draft, path }
  }
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
      const owner = await this.settings.getCollaborationSession()
      const draft = repo.insert({ id, title: basename(source), source: 'manual', sourcePath: source, sourceHash: hash, createdAt: new Date().toISOString(), ownerUserId: owner?.user.id ?? null, version: 1,
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
