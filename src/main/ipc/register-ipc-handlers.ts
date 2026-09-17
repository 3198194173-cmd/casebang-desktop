import { comparePatternsInputSchema, materialInputSchema } from '@shared/schemas'
import { app, ipcMain } from 'electron'
import { SupplementService } from '../modules/supplement/supplement-service'
import { LifecycleService } from '../modules/lifecycle/lifecycle-service'
import type { AppSnapshot } from '@shared/contracts'
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

interface IpcDependencies {
  settings: SettingsRepository
  baseFiles: BaseFileService
  tasks: TaskService
  images: ImageWorkspaceService
  connectors: ConnectorRegistry
  excel: ExcelTemplateEngine
  ai: VisionAiService
  account: CollaborationAuthService
}

export function registerIpcHandlers(dependencies: IpcDependencies): void {
  const lifecycle = new LifecycleService()
  ipcMain.handle(IPC_CHANNELS.lifecycleList, event => { assertTrustedSender(event.senderFrame); return lifecycle.list() })
  ipcMain.handle(IPC_CHANNELS.lifecycleImport, event => { assertTrustedSender(event.senderFrame); return lifecycle.importWorkbook() })
  ipcMain.handle(IPC_CHANNELS.lifecycleGet, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.get(input) })
  ipcMain.handle(IPC_CHANNELS.lifecycleSave, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.save(input) })
  ipcMain.handle(IPC_CHANNELS.lifecyclePreview, (event, input: unknown) => { assertTrustedSender(event.senderFrame); return lifecycle.preview(input) })
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

  ipcMain.handle(IPC_CHANNELS.accountLogin, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.account.login()
  })

  ipcMain.handle(IPC_CHANNELS.accountLogout, async (event) => {
    assertTrustedSender(event.senderFrame)
    return dependencies.account.logout()
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
