import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { LifecycleDraft, LifecycleDraftSummary, LifecycleRowPreview, LifecycleSource, MaterialMasterPreview, SaveMaterialModelInput, SharedLifecycleAnalysis } from '../../../shared/lifecycle-contracts'
import { internalBarcodeCandidate, parsePhoneMaterialCodePrefix, patternVariantKey, planMaterialPatterns, previewMaterialCodes } from '../../../shared/material-coding'
import { normalizeModel, type MaterialModel } from '../../../shared/material-model-dictionary'
import { readLifecycleWorkbook } from './workbook-reader'
import { inspectBarcodeSequence, inspectMaterialMappingRows, writeLifecycleCells } from './workbook-allocator'
import type { LifecycleRepository } from './lifecycle-repository'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'

export class LifecycleService {
  private repository: Promise<LifecycleRepository> | null = null
  private materialMasterCache: { key: string; rows: LifecycleDraft['rows'] } | null = null
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
  async listMaterialModels(): Promise<MaterialModel[]> { return this.settings.getMaterialModels() }
  async saveMaterialModel(input: unknown): Promise<MaterialModel[]> {
    const value = z.object({
      originalBrand: z.enum(['AP', 'SA', 'HW']).optional(), originalCode: z.string().regex(/^\d{2}$/).optional(),
      brand: z.enum(['AP', 'SA', 'HW']), code: z.string().regex(/^\d{2}$/), name: z.string().trim().min(1).max(100),
      aliases: z.array(z.string().trim().min(1).max(100)).max(20)
    }).strict().refine(item => Boolean(item.originalBrand) === Boolean(item.originalCode), '原机型定位字段必须同时提供').parse(input) satisfies SaveMaterialModelInput
    const models = await this.settings.getMaterialModels()
    const editing = value.originalBrand && value.originalCode
      ? models.findIndex(model => model.brand === value.originalBrand && model.code === value.originalCode)
      : -1
    if (value.originalBrand && editing < 0) throw new Error('要修改的机型记录不存在，请刷新后重试。')
    if (models.some((model, index) => index !== editing && model.code === value.code)) throw new Error(`机型编码 ${value.code} 已被其他机型使用。`)
    const aliases = [...new Set(value.aliases.map(alias => alias.trim()).filter(alias => normalizeModel(alias) !== normalizeModel(value.name)))]
    const next: MaterialModel = { brand: value.brand, code: value.code, name: value.name.trim(), aliases }
    const names = new Set([next.name, ...next.aliases].map(normalizeModel))
    if (models.some((model, index) => index !== editing && [model.name, ...model.aliases].some(name => names.has(normalizeModel(name))))) throw new Error('机型名称或别名已被其他机型使用。')
    if (editing >= 0) models[editing] = next
    else models.push(next)
    models.sort((left, right) => left.brand.localeCompare(right.brand) || left.code.localeCompare(right.code))
    await this.settings.setMaterialModels(models)
    return models
  }
  async previewMaterialMaster(input: unknown): Promise<MaterialMasterPreview> {
    const value = z.object({ page: z.number().int().nonnegative(), pageSize: z.number().int().min(10).max(100), query: z.string().trim().max(100).optional() }).strict().parse(input)
    const masterPath = await this.settings.getMaterialMasterPath()
    if (!masterPath) throw new Error('尚未配置物料总表。')
    const rows = await this.loadMaterialMasterRows(masterPath, await this.settings.getMaterialModels())
    const query = value.query?.normalize('NFKC').toUpperCase() ?? ''
    const filtered = query ? rows.filter(row => [row.sheet, row.itemClass, row.materialCode, row.materialName].some(field => field.normalize('NFKC').toUpperCase().includes(query))) : rows
    const start = value.page * value.pageSize
    return { path: masterPath, fileName: basename(masterPath), totalRows: filtered.length, page: value.page, pageSize: value.pageSize, rows: filtered.slice(start, start + value.pageSize) }
  }
  async analyzeSharedFile(
    input: { workItemId: string; title: string; sourceWorkflow: LifecycleSource; version: number; revision: number; monthPrefix: string; patternVariants?: Record<string, string>; patternOverrideEnabled?: boolean; patternOverrideReason?: string },
    workbookPath: string
  ): Promise<SharedLifecycleAnalysis> {
    const masterPath = await this.settings.getMaterialMasterPath()
    if (!masterPath) throw new Error('请先选择最新的物料总表，再计算 69 码起始号码。')
    const modelDictionary = await this.settings.getMaterialModels()
    const parsed = await readLifecycleWorkbook(workbookPath, modelDictionary)
    const variants = input.patternVariants ?? {}
    const [masterRows, master] = await Promise.all([
      this.loadMaterialMasterRows(masterPath, modelDictionary),
      inspectBarcodeSequence(masterPath, input.monthPrefix)
    ])
    const referenceRows = [...masterRows, ...parsed.rows]
    const automaticPlan = planMaterialPatterns(parsed.rows, referenceRows, {}, input.sourceWorkflow)
    const rowKeys = new Set(parsed.rows.map(row => patternVariantKey(row.identity)))
    if (Object.keys(variants).some(key => !rowKeys.has(key))) throw new Error('图案标识不属于当前共享工作簿。')
    const overrides = Object.entries(variants).filter(([key, variant]) => automaticPlan.patternVariants[key] !== variant)
    if (overrides.length && !['new-series', 'new-products'].includes(input.sourceWorkflow)) throw new Error('该来源不允许自定义图案标识。')
    if (overrides.length && !input.patternOverrideEnabled) throw new Error('请先查看自动识别结果，再开启自定义图案标识。')
    if (overrides.length && !input.patternOverrideReason?.trim()) throw new Error('自定义图案标识后必须填写修改原因。')
    const patternPlan = planMaterialPatterns(parsed.rows, referenceRows, variants, input.sourceWorkflow)
    const materialCodePreviews = previewMaterialCodes({ rows: parsed.rows, patternVariants: patternPlan.patternVariants, sourceWorkflow: input.sourceWorkflow })
    // The master workbook is the only committed allocation ledger. Numbers written
    // into an unmerged shared series workbook must not advance this baseline.
    const maximumSequence = master.maximumSequence
    return {
      workItemId: input.workItemId,
      title: input.title,
      sourceWorkflow: input.sourceWorkflow,
      version: input.version,
      revision: input.revision,
      rows: parsed.rows,
      sheetNames: parsed.sheetNames,
      artworkRows: parsed.artworkRows,
      warnings: parsed.warnings,
      materialCodePreviews,
      patternVariants: patternPlan.patternVariants,
      patternPlans: patternPlan.plans,
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
    input: { workItemId: string; title: string; sourceWorkflow: LifecycleSource; version: number; revision: number; monthPrefix: string; fillBarcodes: boolean; fillMaterialCodes: boolean; patternVariants: Record<string, string>; patternOverrideEnabled?: boolean; patternOverrideReason?: string },
    sourcePath: string,
    destinationPath: string
  ): Promise<{ barcodeFilled: number; materialCodeFilled: number; patternOverrides: Array<{ key: string; detectedVariant: string | null; finalVariant: string }> }> {
    if (!input.fillBarcodes && !input.fillMaterialCodes) throw new Error('请至少选择填写 69 码或物料编码中的一项。')
    const analysis = await this.analyzeSharedFile(input, sourcePath)
    if (input.fillMaterialCodes && analysis.patternPlans.some(plan => plan.customized && plan.issues.length)) throw new Error('自定义图案标识存在占用或规则冲突，请修正后再保存。')
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
      const replacePrefix = input.sourceWorkflow === 'new-models' && Boolean(parsePhoneMaterialCodePrefix(row.materialCode))
      if (input.fillMaterialCodes && (!row.materialCode.trim() || replacePrefix) && material?.status === 'candidate' && material.candidate) {
        add(row.sheet, row.materialCodeAddress, material.candidate)
        materialCodeFilled += 1
      }
    }
    if (input.fillBarcodes && barcodeFilled === 0 && analysis.barcodePlan.pendingCount > 0) throw new Error('待填写的 69 码行含公式或缺少物料名称，未自动覆盖，请先人工核实。')
    const hasPendingMaterialCode = analysis.rows.some(row => !row.materialCode.trim() || (input.sourceWorkflow === 'new-models' && Boolean(parsePhoneMaterialCodePrefix(row.materialCode))))
    if (input.fillMaterialCodes && materialCodeFilled === 0 && hasPendingMaterialCode) throw new Error('没有可安全写入的物料编码；请先确认图案标识、历史编码前缀和机型映射。')
    await writeLifecycleCells(sourcePath, destinationPath, writes)
    return { barcodeFilled, materialCodeFilled, patternOverrides: analysis.patternPlans.filter(plan => plan.customized && plan.variant).map(plan => ({
      key: plan.key, detectedVariant: plan.detectedVariant, finalVariant: plan.variant!
    })) }
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
      const selection = await dialog.showOpenDialog({ title: '选择外部共享工作簿（不修改原文件）', properties: ['openFile'], filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] })
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
      const parsed = await readLifecycleWorkbook(snapshot, await this.settings.getMaterialModels())
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

  async inspectWorkbook(input: unknown): Promise<{ warnings: string[]; sheetNames: string[] }> {
    const value = z.object({ path: z.string().trim().min(1) }).strict().parse(input)
    const info = await stat(value.path)
    if (!info.isFile() || !value.path.toLowerCase().endsWith('.xlsx')) throw new Error('请选择有效的 .xlsx 工作簿。')
    const parsed = await readLifecycleWorkbook(value.path, await this.settings.getMaterialModels())
    return { warnings: parsed.warnings, sheetNames: parsed.sheetNames }
  }

  private async loadMaterialMasterRows(masterPath: string, models: readonly MaterialModel[]): Promise<LifecycleDraft['rows']> {
    const file = await stat(masterPath)
    const key = JSON.stringify([masterPath, file.size, file.mtimeMs, models])
    if (this.materialMasterCache?.key === key) return this.materialMasterCache.rows
    const rows = await inspectMaterialMappingRows(masterPath, models)
    this.materialMasterCache = { key, rows }
    return rows
  }
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
