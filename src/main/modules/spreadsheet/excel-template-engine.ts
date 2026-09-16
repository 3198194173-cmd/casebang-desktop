import type { BaseFileKind } from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import type {
  BaseWorkbookInspectionReport,
  VerifiedWorkbookCloneReport
} from './ooxml-types'
import type {
  ControlledWritePlan,
  ControlledWriteReport,
  TemplateConfigBundle
} from '@shared/excel-contracts'
import { OoxmlWorkbookInspector } from './ooxml-workbook-inspector'
import { VerifiedWorkbookCloner } from './verified-workbook-cloner'
import { extractDomesticPatternNamesFromWorkbook, extractProductTypesFromWorkbook, extractSeriesTranslationsFromWorkbook, TemplateConfigGenerator } from './template-config-generator'
import type { DomesticPatternNameRecord, SeriesTranslation } from '@shared/contracts'
import { ControlledWorkbookWriter } from './controlled-workbook-writer'
import { PRODUCT_CATEGORIES } from '@shared/image-contracts'
import type { BuildEncodingPreviewInput, EncodingPreviewResult } from '@shared/coding-contracts'
import { buildEncodingPreviewFromWorkbook } from '../coding/encoding-preview-builder'

const REQUIRED_BASE_FILES: BaseFileKind[] = [
  'namingFormula',
  'barcodeReference',
  'domesticNaming'
]

export class ExcelTemplateEngine {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly inspector = new OoxmlWorkbookInspector(),
    private readonly cloner = new VerifiedWorkbookCloner(inspector),
    private readonly configGenerator = new TemplateConfigGenerator(inspector),
    private readonly writer = new ControlledWorkbookWriter()
  ) {}

  async inspectConfiguredBaseFiles(): Promise<BaseWorkbookInspectionReport> {
    const paths = await this.settings.getBaseFilePaths()
    const missing = REQUIRED_BASE_FILES.filter((kind) => !paths[kind])
    if (missing.length > 0) throw new Error(`基础表尚未全部配置：${missing.join(', ')}`)

    const namingFormula = await this.inspector.inspect(paths.namingFormula!, 'naming-formula')
    const barcodeReference = await this.inspector.inspect(
      paths.barcodeReference!,
      'barcode-reference'
    )
    const domesticNaming = await this.inspector.inspect(paths.domesticNaming!, 'domestic-naming')
    const templates = namingFormula.templates.filter((item) => item.classification === 'template')

    return {
      generatedAt: new Date().toISOString(),
      namingFormula,
      barcodeReference,
      domesticNaming,
      templateCount: templates.length,
      templates
    }
  }

  cloneTemplateWorkbook(
    sourcePath: string,
    destinationPath: string
  ): Promise<VerifiedWorkbookCloneReport> {
    return this.cloner.cloneAndVerify(sourcePath, destinationPath, 'naming-formula')
  }

  generateTemplateConfig(sourcePath: string): Promise<TemplateConfigBundle> {
    return this.configGenerator.generate(sourcePath)
  }

  async listProductTypes(): Promise<string[]> {
    const paths = await this.settings.getBaseFilePaths()
    const fallback = PRODUCT_CATEGORIES.filter((category) => category !== '待确认' && category !== '其他')
    if (!paths.namingFormula) return [...fallback]
    try {
      const types = await extractProductTypesFromWorkbook(paths.namingFormula)
      return types.length > 0 ? types : [...fallback]
    } catch {
      return [...fallback]
    }
  }

  async listSeriesTranslations(): Promise<SeriesTranslation[]> {
    const paths = await this.settings.getBaseFilePaths()
    if (!paths.barcodeReference) return []
    try {
      return await extractSeriesTranslationsFromWorkbook(paths.barcodeReference)
    } catch {
      return []
    }
  }

  async listDomesticPatternNames(): Promise<DomesticPatternNameRecord[]> {
    const paths = await this.settings.getBaseFilePaths()
    if (!paths.domesticNaming) return []
    try {
      return await extractDomesticPatternNamesFromWorkbook(paths.domesticNaming)
    } catch {
      return []
    }
  }

  controlledWrite(
    sourcePath: string,
    destinationPath: string,
    config: TemplateConfigBundle,
    plan: ControlledWritePlan
  ): Promise<ControlledWriteReport> {
    return this.writer.write({ sourcePath, destinationPath, config, ...plan })
  }

  async buildEncodingPreview(input: BuildEncodingPreviewInput): Promise<EncodingPreviewResult> {
    const paths = await this.settings.getBaseFilePaths()
    if (!paths.barcodeReference) throw new Error('请先导入 A条码参考表')
    return buildEncodingPreviewFromWorkbook(paths.barcodeReference, input)
  }
}
