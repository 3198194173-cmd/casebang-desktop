import { comparePatternsInputSchema, materialInputSchema } from '@shared/schemas'
import { app, ipcMain } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { SupplementService } from '../modules/supplement/supplement-service'
import { LifecycleService } from '../modules/lifecycle/lifecycle-service'
import type { AppSnapshot } from '@shared/contracts'
import type { ExportGenerationWorkbookInput } from '@shared/generation-contracts'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import {
  baseFileKindSchema,
  baseFileRollbackSchema,
  analyzeMasterImageInputSchema,
  applicationSettingsSchema,
  buildEncodingPreviewInputSchema,
  cloneTemplateWorkbookInputSchema,
  connectorTestInputSchema,
  controlledWriteIpcInputSchema,
  exportGenerationWorkbookInputSchema,
  publishGenerationWorkbookInputSchema,
  exportConfirmedCropsInputSchema,
  refineCropInputSchema,
  generateTemplateConfigInputSchema,
  saveAiSettingsInputSchema,
  suggestImageNamesBatchInputSchema,
  suggestImageNamesInputSchema,
  translateSeriesNameInputSchema,
  workbookPreviewRequestSchema,
  taskDraftInputSchema
} from '@shared/schemas'
import type { BaseFileService } from '@main/modules/base-files/base-file-service'
import type { ConnectorRegistry } from '@main/modules/integrations/connector-registry'
import type { TaskService } from '@main/modules/tasks/task-service'
import type { ExcelTemplateEngine } from '@main/modules/spreadsheet/excel-template-engine'
import type { ImageWorkspaceService } from '@main/modules/image/image-workspace-service'
import type { VisionAiService } from '@main/modules/naming/vision-ai-service'
import { assertTrustedSender } from '@main/security/trusted-sender'
import { logger } from '@main/infrastructure/logger'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import type { CollaborationAuthService } from '@main/modules/collaboration/collaboration-auth-service'
import type { CollaborationService } from '@main/modules/collaboration/collaboration-service'

interface IpcDependencies {
  settings: SettingsRepository
  baseFiles: BaseFileService
  tasks: TaskService
  images: ImageWorkspaceService
  connectors: ConnectorRegistry
  excel: ExcelTemplateEngine
  ai: VisionAiService
  account: CollaborationAuthService
  collaboration: CollaborationService
}

export function registerIpcHandlers(dependencies: IpcDependencies): void {
  const lifecycle = new LifecycleService(dependencies.settings)
  ipcMain.handle(IPC_CHANNELS.lifecycleList, event => { assertTrustedSender(event.senderFrame); return lifecycle.list() })
  ipcMain.handle(IPC_CHANNELS.lifecycleImport, event => { assertTrustedSender(event.senderFrame); return lifecycle.importWorkbook() })
  ipcMain.handle(IPC_CHANNELS.lifecycleGet, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.get(input) })
  ipcMain.handle(IPC_CHANNELS.lifecycleSave, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.save(input) })
  ipcMain.handle(IPC_CHANNELS.lifecyclePreview, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.preview(input) })
  ipcMain.handle(IPC_CHANNELS.lifecyclePreviewMaterialMaster, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.previewMaterialMaster(input) })
  ipcMain.handle(IPC_CHANNELS.lifecycleListMaterialModels, event => { assertTrustedSender(event.senderFrame); return lifecycle.listMaterialModels() })
  ipcMain.handle(IPC_CHANNELS.lifecycleSaveMaterialModel, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.saveMaterialModel(input) })
  const sharedAnalysisSchema = z.object({
    workItemId: z.string().uuid(), title: z.string().trim().min(1).max(240),
    sourceWorkflow: z.enum(['new-series', 'new-products', 'new-models', 'manual']),
    version: z.number().int().positive(), revision: z.number().int().positive(),
    monthPrefix: z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/),
    patternVariants: z.record(z.string().max(1000), z.string().regex(/^[A-Z0-9]{2}$/)).optional(),
    patternOverrideEnabled: z.boolean().optional(),
    patternOverrideReason: z.string().trim().max(500).optional()
  }).strict()
  ipcMain.handle(IPC_CHANNELS.lifecycleAnalyzeShared, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = sharedAnalysisSchema.parse(input)
    await dependencies.collaboration.syncMaterialMaster()
    const workItem = (await dependencies.collaboration.workItems()).find(item => item.id === request.workItemId)
    if (!workItem) throw new Error('共享工作簿不存在或当前账号无权访问。')
    if (workItem.sourceWorkflow !== request.sourceWorkflow || workItem.version !== request.version || workItem.revision !== request.revision) throw new Error('共享工作簿来源或版本已变化，请刷新后重试。')
    const directory = await mkdtemp(join(app.getPath('temp'), 'casebang-lifecycle-analysis-'))
    try {
      const path = join(directory, 'shared.xlsx')
      await writeFile(path, await dependencies.collaboration.downloadWorkbook({ workItemId: request.workItemId }))
      return await lifecycle.analyzeSharedFile({ ...request, title: workItem.title, sourceWorkflow: workItem.sourceWorkflow }, path)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  ipcMain.handle(IPC_CHANNELS.lifecycleApplyShared, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = sharedAnalysisSchema.omit({ version: true, revision: true }).extend({
      expectedVersion: z.number().int().positive(), expectedRevision: z.number().int().positive(),
      fillBarcodes: z.boolean(), fillMaterialCodes: z.boolean(), openOnlineAfterSave: z.boolean().optional()
    }).strict().parse(input)
    await dependencies.collaboration.syncMaterialMaster()
    const workItem = (await dependencies.collaboration.workItems()).find(item => item.id === request.workItemId)
    if (!workItem) throw new Error('共享工作簿不存在或当前账号无权访问。')
    if (workItem.sourceWorkflow !== request.sourceWorkflow || workItem.version !== request.expectedVersion || workItem.revision !== request.expectedRevision) throw new Error('共享工作簿来源或版本已变化，请刷新后重试。')
    const directory = await mkdtemp(join(app.getPath('temp'), 'casebang-lifecycle-write-'))
    try {
      const source = join(directory, 'source.xlsx')
      const destination = join(directory, 'allocated.xlsx')
      await writeFile(source, await dependencies.collaboration.downloadWorkbook({ workItemId: request.workItemId }))
      const counts = await lifecycle.writeSharedFile({
        ...request, version: request.expectedVersion, revision: request.expectedRevision,
        title: workItem.title, sourceWorkflow: workItem.sourceWorkflow, patternVariants: request.patternVariants ?? {}
      }, source, destination)
      const saved = await dependencies.collaboration.saveWorkbookRevision({
        workItemId: request.workItemId, title: request.title,
        expectedVersion: request.expectedVersion, expectedRevision: request.expectedRevision,
        bytes: await readFile(destination),
        changeReason: counts.patternOverrides.length ? request.patternOverrideReason : undefined,
        patternOverrides: counts.patternOverrides
      })
      let openedOnline = false
      if (request.openOnlineAfterSave) {
        await dependencies.collaboration.openOnlineWorkbook({ workItemId: request.workItemId })
        openedOnline = true
      }
      return { item: saved.item, ...counts, openedOnline }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  const supplement = new SupplementService()
  ipcMain.handle(IPC_CHANNELS.supplementGetMaster, async event => { assertTrustedSender(event.senderFrame); return dependencies.settings.getMaterialMasterPath() })
  ipcMain.handle(IPC_CHANNELS.supplementSelectMaster, async event => {
    assertTrustedSender(event.senderFrame)
    const path = await supplement.select()
    if (path) await dependencies.settings.setMaterialMasterPath(path)
    return path
  })
  ipcMain.handle(IPC_CHANNELS.supplementSelect, async event => { assertTrustedSender(event.senderFrame); return supplement.select() })
  ipcMain.handle(IPC_CHANNELS.supplementAnalyze, async (event, input: unknown) => { assertTrustedSender(event.senderFrame); return supplement.analyze(input) })
  ipcMain.handle(IPC_CHANNELS.supplementExport, async (event, input: unknown) => { assertTrustedSender(event.senderFrame); return supplement.export(input) })
  ipcMain.handle(IPC_CHANNELS.supplementPublishShared, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = z.object({ title: z.string().trim().min(1).max(180), overrides: z.unknown() }).strict().parse(input)
    const stagingDirectory = await mkdtemp(join(app.getPath('temp'), 'casebang-supplement-shared-'))
    try {
      const path = await supplement.exportTo(join(stagingDirectory, 'supplement.xlsx'), request.overrides)
      return await dependencies.collaboration.publishWorkbook({ path, title: `${request.title.replace(/\.xlsx$/i, '')}.xlsx`, sourceWorkflow: 'new-models' })
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch((reason: unknown) => {
        logger.warn('Could not remove supplement staging directory', { error: reason instanceof Error ? reason.message : String(reason) })
      })
    }
  })
  ipcMain.handle(IPC_CHANNELS.appGetSnapshot, async (event): Promise<AppSnapshot> => {
    assertTrustedSender(event.senderFrame)
    return {
      appVersion: app.getVersion(),
      baseFiles: await dependencies.baseFiles.list(),
      connectors: dependencies.connectors.list(),
      productTypes: await dependencies.excel.listProductTypes(),
      seriesTranslations: await dependencies.excel.listSeriesTranslations(),
      domesticPatternNames: await dependencies.excel.listDomesticPatternNames(),
      productImageMappingIndex: await dependencies.baseFiles.productImageMappingIndex()
    }
  })

  ipcMain.handle(IPC_CHANNELS.settingsGet, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.settings.getApplicationSettings()
  })

  ipcMain.handle(IPC_CHANNELS.settingsSave, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = applicationSettingsSchema.parse(input)
    logger.info('Saving application settings', request)
    return dependencies.settings.setApplicationSettings(request)
  })

  ipcMain.handle(IPC_CHANNELS.accountGet, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.account.get()
  })

  ipcMain.handle(IPC_CHANNELS.accountLogin, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.account.login(input)
  })

  ipcMain.handle(IPC_CHANNELS.accountLogout, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.account.logout()
  })

  ipcMain.handle(IPC_CHANNELS.collaborationMembers, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.members()
  })

  ipcMain.handle(IPC_CHANNELS.collaborationWorkItems, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.workItems()
  })

  ipcMain.handle(IPC_CHANNELS.collaborationPublishWorkbook, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.publishWorkbook(input)
  })

  ipcMain.handle(IPC_CHANNELS.collaborationSubmitLifecycle, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.submitLifecycle(input, lifecycle)
  })

  ipcMain.handle(IPC_CHANNELS.collaborationAct, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.act(input)
  })

  ipcMain.handle(IPC_CHANNELS.collaborationOpenWorkbook, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.openWorkbook(input)
  })

  ipcMain.handle(IPC_CHANNELS.collaborationOpenOnlineWorkbook, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.openOnlineWorkbook(input)
  })

  ipcMain.handle(IPC_CHANNELS.collaborationMaterialMaster, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.materialMaster()
  })

  ipcMain.handle(IPC_CHANNELS.collaborationPublishMaterialMaster, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.publishMaterialMaster()
  })

  ipcMain.handle(IPC_CHANNELS.collaborationSyncMaterialMaster, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.collaboration.syncMaterialMaster()
  })

  ipcMain.handle(IPC_CHANNELS.baseFilesSelect, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const kind = baseFileKindSchema.parse(input)
    logger.info('Selecting base workbook', { kind })
    return dependencies.baseFiles.select(kind)
  })

  ipcMain.handle(IPC_CHANNELS.baseFilesPreview, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.baseFiles.preview(workbookPreviewRequestSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.baseFilesHistory, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.baseFiles.getHistory()
  })

  ipcMain.handle(IPC_CHANNELS.baseFilesRollback, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.baseFiles.rollback(baseFileRollbackSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.tasksSelectMasterImage, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.tasks.selectMasterImage()
  })

  ipcMain.handle(IPC_CHANNELS.tasksCreateDraft, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const taskInput = taskDraftInputSchema.parse(input)
    logger.info('Creating task draft', { templateName: taskInput.templateName })
    return dependencies.tasks.createDraft(taskInput)
  })

  ipcMain.handle(IPC_CHANNELS.tasksExportGenerationWorkbook, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const parsed = exportGenerationWorkbookInputSchema.safeParse(input)
    if (!parsed.success) {
      logger.error('Invalid generation workbook request', { issues: parsed.error.issues })
      throw new Error('导出数据校验失败，请返回“生成与质检”重新生成后重试。')
    }
    const request = parsed.data
    logger.info('Exporting generation review workbook', {
      title: request.workspace.title,
      selectedWorkbookIds: request.selectedWorkbookIds,
      overwriteBaseFiles: request.overwriteBaseFiles
    })
    const result = await dependencies.tasks.exportGenerationWorkbook(request)
    logger.info('Generation workbook operation finished', {
      canceled: result.canceled,
      exportedCount: result.files?.length ?? 0,
      overwrittenCount: result.overwritten?.length ?? 0,
      skippedCount: result.skipped?.length ?? 0
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.tasksPublishGenerationWorkbook, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const parsed = publishGenerationWorkbookInputSchema.safeParse(input)
    if (!parsed.success) {
      logger.error('Invalid shared workbook request', { issues: parsed.error.issues })
      throw new Error('共享工作簿数据校验失败，请返回“生成与质检”重新生成后重试。')
    }
    const generatedWorkbook = parsed.data.generation.workspace.workbooks.find((book) => book.id === 'generated-product')
    if (!generatedWorkbook) throw new Error('缺少新建产品表，无法建立共享工作簿。')
    const request: ExportGenerationWorkbookInput = {
      ...parsed.data.generation,
      workspace: { ...parsed.data.generation.workspace, workbooks: [generatedWorkbook] },
      selectedWorkbookIds: ['generated-product'],
      overwriteBaseFiles: false
    }
    const stagingDirectory = await mkdtemp(join(app.getPath('temp'), 'casebang-shared-workbook-'))
    try {
      logger.info('Preparing generated workbook for central storage', { title: request.workspace.title })
      const generated = await dependencies.tasks.exportGenerationWorkbook(request, { outputDirectory: stagingDirectory })
      const workbook = generated.files?.find((file) => file.label === '新建产品表')
      if (!workbook) throw new Error('新建产品表生成失败，未建立共享工作簿。')
      return await dependencies.collaboration.publishWorkbook({
        path: workbook.path,
        title: workbook.fileName,
        sourceWorkflow: parsed.data.sourceWorkflow
      })
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch((reason: unknown) => {
        logger.warn('Could not remove shared workbook staging directory', {
          error: reason instanceof Error ? reason.message : String(reason)
        })
      })
    }
  })

  ipcMain.handle(IPC_CHANNELS.imagesAnalyze, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = analyzeMasterImageInputSchema.parse(input)
    logger.info('Analyzing master product image', { sourceImagePath: request.sourceImagePath })
    return dependencies.images.analyze(request.sourceImagePath)
  })

  ipcMain.handle(IPC_CHANNELS.imagesRefineCrop, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = refineCropInputSchema.parse(input)
    logger.info('Refining selected image crop', { cropId: request.crop.id })
    return dependencies.images.refineCrop(request.sourceImagePath, request.crop)
  })

  ipcMain.handle(IPC_CHANNELS.imagesExportCrops, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = exportConfirmedCropsInputSchema.parse(input)
    logger.info('Exporting confirmed image crops', { cropCount: request.crops.length })
    return dependencies.images.exportCrops(request)
  })

  ipcMain.handle(IPC_CHANNELS.aiGetSettings, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.ai.getSettings()
  })

  ipcMain.handle(IPC_CHANNELS.aiSaveSettings, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = saveAiSettingsInputSchema.parse(input)
    return dependencies.ai.saveSettings(request)
  })

  ipcMain.handle(IPC_CHANNELS.aiTestConnection, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.ai.testConnection()
  })

  ipcMain.handle(IPC_CHANNELS.aiRecognizeMaterial, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.ai.recognizeMaterial(materialInputSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.aiComparePatterns, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.ai.comparePatterns(comparePatternsInputSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.aiSuggestImageNames, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = suggestImageNamesInputSchema.parse(input)
    logger.info('Suggesting image names with configured AI provider', { cropId: request.crop.id })
    return dependencies.ai.suggestImageNames(request)
  })

  ipcMain.handle(IPC_CHANNELS.aiSuggestImageNamesBatch, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = suggestImageNamesBatchInputSchema.parse(input)
    logger.info('Suggesting names for multiple cropped images', { cropCount: request.crops.length })
    return dependencies.ai.suggestImageNamesBatch(request)
  })

  ipcMain.handle(IPC_CHANNELS.aiTranslateSeriesName, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = translateSeriesNameInputSchema.parse(input)
    logger.info('Translating Chinese series name', { chineseNameLength: request.chineseName.length })
    return dependencies.ai.translateSeriesName(request.chineseName)
  })

  ipcMain.handle(IPC_CHANNELS.integrationsTest, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = connectorTestInputSchema.parse(input)
    return dependencies.connectors.test(request.connectorId)
  })

  ipcMain.handle(IPC_CHANNELS.excelInspectBaseFiles, async (event) => {
    assertTrustedSender(event.senderFrame)
    logger.info('Inspecting configured base workbooks')
    return dependencies.excel.inspectConfiguredBaseFiles()
  })

  ipcMain.handle(IPC_CHANNELS.excelCloneTemplateWorkbook, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = cloneTemplateWorkbookInputSchema.parse(input)
    logger.info('Creating verified template workbook clone', {
      destinationPath: request.destinationPath
    })
    return dependencies.excel.cloneTemplateWorkbook(request.sourcePath, request.destinationPath)
  })

  ipcMain.handle(IPC_CHANNELS.excelGenerateTemplateConfig, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = generateTemplateConfigInputSchema.parse(input)
    logger.info('Generating workbook template field configuration', { sourcePath: request.sourcePath })
    return dependencies.excel.generateTemplateConfig(request.sourcePath)
  })

  ipcMain.handle(IPC_CHANNELS.excelControlledWrite, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = controlledWriteIpcInputSchema.parse(input)
    logger.info('Applying controlled workbook write', { destinationPath: request.destinationPath })
    return dependencies.excel.controlledWrite(
      request.sourcePath,
      request.destinationPath,
      request.config as Parameters<ExcelTemplateEngine['controlledWrite']>[2],
      request.plan
    )
  })

  ipcMain.handle(IPC_CHANNELS.excelBuildEncodingPreview, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame)
    const request = buildEncodingPreviewInputSchema.parse(input)
    logger.info('Building product code allocation preview', { cropCount: request.crops.length })
    return dependencies.excel.buildEncodingPreview(request)
  })
}

export function unregisterIpcHandlers(): void {
  Object.values(IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel))
}
