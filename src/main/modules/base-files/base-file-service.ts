import { access, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, dialog } from 'electron'
import {
  BASE_FILE_DEFINITIONS,
  type BaseFileKind,
  type BaseFileRecord,
  type BaseFileUpdateRecord,
  type WorkbookPreviewRequest,
  type WorkbookPreviewResult
} from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import { WorkbookPreviewService } from '@main/modules/spreadsheet/workbook-preview-service'
import { assertWorkbookWritable, copyWorkbookWithRetry } from '@main/modules/spreadsheet/safe-workbook-file'

export class BaseFileService {
  private readonly previewer = new WorkbookPreviewService()

  constructor(private readonly settings: SettingsRepository) {}

  async list(): Promise<Record<BaseFileKind, BaseFileRecord>> {
    const paths = await this.settings.getBaseFilePaths()
    const entries = await Promise.all(
      (Object.keys(BASE_FILE_DEFINITIONS) as BaseFileKind[]).map(async (kind) => [
        kind,
        await this.toRecord(kind, paths[kind] ?? null)
      ] as const)
    )

    return Object.fromEntries(entries) as Record<BaseFileKind, BaseFileRecord>
  }

  async select(kind: BaseFileKind): Promise<BaseFileRecord> {
    const definition = BASE_FILE_DEFINITIONS[kind]
    const selection = await dialog.showOpenDialog({
      title: `选择${definition.label}`,
      properties: ['openFile'],
      filters: [{ name: 'Excel 工作簿', extensions: definition.extensions }]
    })

    if (selection.canceled || !selection.filePaths[0]) {
      const current = await this.list()
      return current[kind]
    }

    const filePath = selection.filePaths[0]
    const extension = extname(filePath).slice(1).toLowerCase()
    if (!definition.extensions.includes(extension)) {
      throw new Error(`请选择 ${definition.extensions.join('/')} 格式的工作簿`)
    }

    await this.settings.setBaseFilePath(kind, filePath)
    return this.toRecord(kind, filePath)
  }

  async preview(input: WorkbookPreviewRequest): Promise<WorkbookPreviewResult> {
    const paths = await this.settings.getBaseFilePaths()
    const filePath = paths[input.kind]
    if (!filePath) throw new Error('请先导入该基础表')
    await access(filePath)
    return this.previewer.read(filePath, input)
  }

  getHistory(): Promise<BaseFileUpdateRecord[]> {
    return this.settings.getBaseFileUpdates()
  }

  async rollback(recordId: string): Promise<BaseFileUpdateRecord> {
    const record = (await this.settings.getBaseFileUpdates()).find((item) => item.id === recordId)
    if (!record) throw new Error('找不到指定的覆盖记录')
    if (record.rolledBackAt) throw new Error('该基础表已经回滚，无需重复操作')
    await access(record.backupPath)
    const paths = await this.settings.getBaseFilePaths()
    const sourcePath = paths[record.kind]
    if (!sourcePath || sourcePath !== record.sourcePath) throw new Error('当前基础表路径已变化，不能直接回滚该历史版本')
    await access(sourcePath)
    await assertWorkbookWritable(sourcePath, record.sourceFileName)

    const safetyBackupPath = join(app.getPath('userData'), 'base-file-backups', record.kind, `${Date.now()}-${randomUUID()}-rollback-${basename(sourcePath)}`)
    await mkdir(dirname(safetyBackupPath), { recursive: true })
    await copyWorkbookWithRetry(sourcePath, safetyBackupPath, { label: record.sourceFileName, action: '备份' })
    await copyWorkbookWithRetry(record.backupPath, sourcePath, { label: record.sourceFileName, action: '回滚' })
    await this.settings.addBaseFileUpdate({
      id: randomUUID(),
      batchId: record.batchId,
      historyRole: 'rollback-safety',
      parentRecordId: record.id,
      kind: record.kind,
      taskName: record.taskName,
      operationName: record.operationName ?? record.taskName,
      changeSummary: '回滚前自动保存的当前版本',
      sourcePath,
      sourceFileName: basename(sourcePath),
      backupPath: safetyBackupPath,
      createdAt: new Date().toISOString(),
      rolledBackAt: null
    })
    return this.settings.markBaseFileUpdateRolledBack(record.id, new Date().toISOString())
  }

  private async toRecord(kind: BaseFileKind, filePath: string | null): Promise<BaseFileRecord> {
    const label = BASE_FILE_DEFINITIONS[kind].label
    if (!filePath) {
      return { kind, label, path: null, fileName: null, status: 'not-configured', updatedAt: null }
    }

    try {
      const file = await stat(filePath)
      return {
        kind,
        label,
        path: filePath,
        fileName: basename(filePath),
        status: 'ready',
        updatedAt: file.mtime.toISOString()
      }
    } catch {
      return {
        kind,
        label,
        path: filePath,
        fileName: basename(filePath),
        status: 'missing',
        updatedAt: null
      }
    }
  }
}
