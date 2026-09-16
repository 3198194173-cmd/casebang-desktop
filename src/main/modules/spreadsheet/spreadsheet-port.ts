export interface WorkbookTemplateInfo {
  templateId: string
  sheetNames: string[]
  productSlots: string[]
  versionFingerprint: string
}

export interface WorkbookOutputSet {
  seriesWorkbookPath: string
  barcodeReferenceCopyPath: string
  domesticNamingCopyPath: string
  qualityReportPath: string
}

export interface SpreadsheetPort {
  inspectTemplate(filePath: string): Promise<WorkbookTemplateInfo[]>
  createReadOnlyWorkingCopy(sourcePath: string, taskDirectory: string): Promise<string>
  generateOutputs(taskId: string): Promise<WorkbookOutputSet>
}

export class OoxmlSpreadsheetPort implements SpreadsheetPort {
  constructor(
    private readonly inspector = new OoxmlWorkbookInspector(),
    private readonly cloner = new VerifiedWorkbookCloner(inspector)
  ) {}

  async inspectTemplate(filePath: string): Promise<WorkbookTemplateInfo[]> {
    const inspection = await this.inspector.inspect(filePath, 'naming-formula')
    return inspection.templates
      .filter((template) => template.classification === 'template')
      .map((template) => ({
        templateId: template.id,
        sheetNames: [template.sheetName],
        productSlots: [],
        versionFingerprint: inspection.componentFingerprints.worksheets
      }))
  }

  async createReadOnlyWorkingCopy(sourcePath: string, taskDirectory: string): Promise<string> {
    const destinationPath = join(taskDirectory, `source-${basename(sourcePath)}`)
    const report = await this.cloner.cloneAndVerify(
      sourcePath,
      destinationPath,
      'naming-formula'
    )
    if (!report.passed) throw new Error('模板工作副本验证失败')
    return destinationPath
  }

  async generateOutputs(): Promise<WorkbookOutputSet> {
    throw new Error('受控字段写入与最终输出将在下一阶段接入')
  }
}

export class UnconfiguredSpreadsheetPort implements SpreadsheetPort {
  async inspectTemplate(): Promise<WorkbookTemplateInfo[]> {
    throw new Error('Excel 模板引擎尚未接入')
  }

  async createReadOnlyWorkingCopy(): Promise<string> {
    throw new Error('Excel 模板引擎尚未接入')
  }

  async generateOutputs(): Promise<WorkbookOutputSet> {
    throw new Error('Excel 模板引擎尚未接入')
  }
}
import { basename, join } from 'node:path'
import { OoxmlWorkbookInspector } from './ooxml-workbook-inspector'
import { VerifiedWorkbookCloner } from './verified-workbook-cloner'
