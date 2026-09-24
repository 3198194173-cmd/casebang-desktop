import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, dialog } from 'electron'
import type { SelectFileResult, TaskDraft, TaskDraftBasicsInput } from '@shared/contracts'
import type { ExportGenerationWorkbookInput, ExportGenerationWorkbookResult } from '@shared/generation-contracts'
import { exportFormatPreservingWorkbook } from './format-preserving-generation-exporter'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import { OoxmlWorkbookInspector } from '@main/modules/spreadsheet/ooxml-workbook-inspector'
import { assertWorkbookWritable, copyWorkbookWithRetry } from '@main/modules/spreadsheet/safe-workbook-file'
import { logger } from '@main/infrastructure/logger'

export class TaskService {
  private masterImageSelection: Promise<SelectFileResult> | null = null

  constructor(private readonly settings: SettingsRepository) {}

  async selectMasterImage(): Promise<SelectFileResult> {
    if (this.masterImageSelection) {
      logger.info('Reusing active Windows image picker')
      return this.masterImageSelection
    }
    const selection = this.selectMasterImageOnce()
    this.masterImageSelection = selection
    try {
      return await selection
    } finally {
      if (this.masterImageSelection === selection) this.masterImageSelection = null
    }
  }

  private async selectMasterImageOnce(): Promise<SelectFileResult> {
    const lastDirectory = await this.settings.getLastMasterImageDirectory()
    const startedAt = Date.now()
    logger.info('Opening native Electron image picker', { hasRememberedDirectory: Boolean(lastDirectory) })
    const selection = await dialog.showOpenDialog({
      title: '选择一张产品排版总图',
      defaultPath: lastDirectory ?? undefined,
      properties: ['openFile'],
      filters: [{ name: '产品图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'] }]
    })
    logger.info('Native Electron image picker returned', { canceled: selection.canceled, elapsedMs: Date.now() - startedAt })
    const selectedPath = selection.canceled ? null : selection.filePaths[0] ?? null
    if (selectedPath) {
      if (!['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'].includes(extname(selectedPath).toLowerCase())) {
        throw new Error('请选择 PNG、JPG、WEBP 或 TIFF 图片。')
      }
      await access(selectedPath)
      await this.settings.setLastMasterImageDirectory(dirname(selectedPath))
      logger.info('Master image selected', { extension: extname(selectedPath).toLowerCase() })
    }

    return {
      canceled: !selectedPath,
      path: selectedPath
    }
  }

  async createDraft(input: TaskDraftBasicsInput): Promise<TaskDraft> {
    await access(input.masterImagePath)
    const draft: TaskDraft = {
      ...input,
      templateName: '自动按产品类型',
      selectedModels: [],
      modelBrandAssignments: {},
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'draft'
    }
    if ((await this.settings.getApplicationSettings()).autoSaveDrafts) await saveDraftRecoveryPoint(draft)
    return draft
  }

  async exportGenerationWorkbook(input: ExportGenerationWorkbookInput, options: { outputDirectory?: string } = {}): Promise<ExportGenerationWorkbookResult> {
    const preferences = await this.settings.getApplicationSettings()
    if (preferences.requireQualityCheck && input.workspace.checks.some((check) => !check.passed)) {
      throw new Error('导出前强制质检已开启，请先处理所有未通过项目。')
    }
    const safeName = input.suggestedName.replace(/[\\/:*?\"<>|]+/g, '-').replace(/\.xlsx$/i, '')
    const selectedIds = new Set(input.selectedWorkbookIds ?? ['generated-product'])
    if (selectedIds.has('product-image-mapping') || input.workspace.workbooks.some((book) => book.id === 'product-image-mapping')) {
      throw new Error('新系列建表和系列补产品不再生成或覆盖 K3 名称对应产品图片。')
    }
    const generatedTemplatePath = resolveGeneratedProductTemplatePath()
    await Promise.all([
      ...[input.sourcePaths.namingFormula, input.sourcePaths.barcodeReference, input.sourcePaths.domesticNaming].map((path) => access(path)),
      ...(selectedIds.has('generated-product') ? [access(generatedTemplatePath)] : [])
    ])
    const overwriteBaseFiles = input.overwriteBaseFiles ?? false
    const configuredBaseFiles = await this.settings.getBaseFilePaths()
    const requiresOutputDirectory = selectedIds.has('generated-product') || !overwriteBaseFiles
    let outputDirectory: string | null = options.outputDirectory ?? null
    const skipped: Array<{ label: string; reason: string }> = []
    if (requiresOutputDirectory && !outputDirectory) {
      const selection = await dialog.showOpenDialog({
        title: '选择 Excel 文件的导出文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      outputDirectory = selection.filePaths[0] ?? null
      if (selection.canceled || !outputDirectory) {
        const selectedBaseIds = (['barcode-reference', 'domestic-naming'] as const).filter((id) => selectedIds.has(id))
        if (!overwriteBaseFiles || selectedBaseIds.length === 0) {
          return { canceled: true, outputPath: null, fileName: null, files: [], overwritten: [], skipped: [] }
        }
        // The user already explicitly confirmed the base-file overwrite in the
        // renderer. Canceling the separate output-folder picker only skips
        // outputs that need a folder; it must not silently cancel that update.
        if (selectedIds.delete('generated-product')) {
          skipped.push({ label: '新建产品表', reason: '未选择导出目录，本次仅完成基础资料覆盖' })
        }
        logger.info('Output directory selection canceled; continuing confirmed base workbook update', {
          selectedBaseIds
        })
      }
    }
    const outputDefinitions = [
      { id: 'barcode-reference', label: 'A条码参考更新表', preferred: `A条码参考-${safeName}.xlsx` },
      { id: 'domestic-naming', label: '国内命名更新表', preferred: `国内命名-${safeName}.xlsx` },
      { id: 'generated-product', label: '新建产品表', preferred: `${safeName || 'CASEBANG-新建产品表'}.xlsx` }
    ] as const
    const files: Array<{ label: string; path: string; fileName: string }> = []
    const overwritten: Array<{ label: string; path: string; historyId: string }> = []
    const historyRecords: Parameters<SettingsRepository['addBaseFileUpdate']>[0][] = []
    const appliedOverwrites: Array<{ sourcePath: string; backupPath: string }> = []
    const overwriteBatchId = randomUUID()
    const overwriteStartedAt = new Date().toISOString()
    const operationName = `${safeName || 'CASEBANG-新建产品表'}.xlsx`
    try {
      if (overwriteBaseFiles) {
        for (const definition of outputDefinitions.filter((item) => selectedIds.has(item.id))) {
          if (definition.id === 'generated-product') continue
          const overwriteKind = baseKindForWorkbook(definition.id)
          const sourcePath = input.sourcePaths[overwriteKind]
          if (!sourcePath) throw new Error(`请先导入${definition.label}`)
          const configuredPath = configuredBaseFiles[overwriteKind]
          if (!configuredPath || resolve(configuredPath).toLowerCase() !== resolve(sourcePath).toLowerCase()) {
            throw new Error(`${definition.label}已不是“基础资料”当前使用的文件，请返回基础资料重新确认后再覆盖。`)
          }
          await assertWorkbookWritable(sourcePath, definition.label)
        }
      }
      for (const definition of outputDefinitions.filter((item) => selectedIds.has(item.id))) {
      const workbook = input.workspace.workbooks.find((item) => item.id === definition.id)
      if (!workbook) throw new Error(`缺少导出内容：${definition.label}`)
      const sourcePath = workbook.id === 'barcode-reference'
        ? input.sourcePaths.barcodeReference
        : workbook.id === 'domestic-naming'
          ? input.sourcePaths.domesticNaming
          : generatedTemplatePath
      if (!sourcePath) throw new Error(`请先导入${definition.label}`)
      const overwriteKind = workbook.id === 'barcode-reference'
        ? 'barcodeReference' as const
        : workbook.id === 'domestic-naming'
          ? 'domesticNaming' as const
          : null
      if (overwriteBaseFiles && overwriteKind) {
        const configuredPath = configuredBaseFiles[overwriteKind]
        if (!configuredPath || resolve(configuredPath).toLowerCase() !== resolve(sourcePath).toLowerCase()) {
          throw new Error(`${definition.label}已不是“基础资料”当前使用的文件，请返回基础资料重新确认后再覆盖。`)
        }
        const temporaryPath = join(dirname(sourcePath), `.${basename(sourcePath)}.casebang-${randomUUID()}.xlsx`)
        try {
          await exportFormatPreservingWorkbook(sourcePath, temporaryPath, workbook, input)
          const role = overwriteKind === 'barcodeReference' ? 'barcode-reference' as const : 'domestic-naming' as const
          await new OoxmlWorkbookInspector().inspect(temporaryPath, role)
          const backupPath = join(app.getPath('userData'), 'base-file-backups', overwriteKind, `${Date.now()}-${randomUUID()}-${basename(sourcePath)}`)
          await mkdir(dirname(backupPath), { recursive: true })
          await copyWorkbookWithRetry(sourcePath, backupPath, { label: definition.label, action: '备份' })
          const historyId = randomUUID()
          await copyWorkbookWithRetry(temporaryPath, sourcePath, { label: definition.label, action: '覆盖' })
          // Only a completed destination write belongs in the rollback set.
          // Adding it earlier masks the original lock error with a second,
          // failing backup restore attempt.
          appliedOverwrites.push({ sourcePath, backupPath })
          historyRecords.push({
            id: historyId,
            batchId: overwriteBatchId,
            historyRole: 'overwrite',
            kind: overwriteKind,
            taskName: operationName,
            operationName,
            changeSummary: overwriteKind === 'barcodeReference'
              ? '系列名对应代码、全系列主图及各产品类别最新已使用编码'
              : '可拆卸+其他中的全系列主图、图案图片及对应名称',
            sourcePath,
            sourceFileName: basename(sourcePath),
            backupPath,
            createdAt: overwriteStartedAt,
            rolledBackAt: null
          })
          overwritten.push({ label: definition.label, path: sourcePath, historyId })
          logger.info('Base workbook updated with automatic backup', {
            kind: overwriteKind,
            sourcePath,
            backupPath,
            historyId
          })
        } finally {
          await rm(temporaryPath, { force: true })
        }
      } else {
        if (!outputDirectory) throw new Error('尚未选择导出文件夹')
        const path = await availablePath(outputDirectory, definition.preferred)
        await exportFormatPreservingWorkbook(sourcePath, path, workbook, input)
        files.push({ label: definition.label, path, fileName: basename(path) })
      }
      }
      if (historyRecords.length > 0) {
        await this.settings.addBaseFileUpdates(historyRecords)
        logger.info('Base workbook update history saved', { recordCount: historyRecords.length })
      }
    } catch (reason) {
      const rollbackFailures: string[] = []
      for (const applied of appliedOverwrites.toReversed()) {
        try {
          await copyWorkbookWithRetry(applied.backupPath, applied.sourcePath, { label: basename(applied.sourcePath), action: '恢复' })
        } catch (rollbackReason) {
          rollbackFailures.push(rollbackReason instanceof Error ? rollbackReason.message : String(rollbackReason))
        }
      }
      if (rollbackFailures.length > 0) {
        logger.error('Base workbook transaction rollback was incomplete', {
          originalError: reason instanceof Error ? reason.message : String(reason),
          rollbackFailures
        })
        throw new Error(`${reason instanceof Error ? reason.message : '基础资料覆盖失败'}\n自动恢复未全部完成，请不要继续覆盖，并检查日志。${rollbackFailures.join('\n')}`)
      }
      throw reason
    }
    return {
      canceled: false,
      outputPath: outputDirectory,
      fileName: null,
      files,
      overwritten,
      skipped
    }
  }
}

function baseKindForWorkbook(id: 'barcode-reference' | 'domestic-naming') {
  return id === 'barcode-reference' ? 'barcodeReference' : 'domesticNaming'
}

function resolveGeneratedProductTemplatePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'generated-product-template.xlsx')
    : join(app.getAppPath(), 'resources', 'generated-product-template.xlsx')
}

async function saveDraftRecoveryPoint(draft: TaskDraft): Promise<void> {
  const filePath = join(app.getPath('userData'), 'drafts', 'latest.json')
  const temporaryPath = `${filePath}.tmp`
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(temporaryPath, JSON.stringify(draft, null, 2), 'utf8')
  await rename(temporaryPath, filePath)
}

async function availablePath(directory: string, preferredName: string): Promise<string> {
  const extension = '.xlsx'
  const stem = preferredName.replace(/\.xlsx$/i, '')
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = join(directory, index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`)
    try { await stat(candidate) } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw reason
    }
  }
  throw new Error('导出目录中同名文件过多，请更换目录。')
}
