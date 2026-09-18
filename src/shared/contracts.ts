import type { ComparePatternsInput, ComparePatternsResult } from './pattern-comparison'
import type {
  BaseWorkbookInspectionReport,
  CloneTemplateWorkbookInput,
  ControlledWritePlan,
  ControlledWriteReport,
  GenerateTemplateConfigInput,
  TemplateConfigBundle,
  VerifiedWorkbookCloneReport
} from './excel-contracts'
import type {
  AnalyzeMasterImageInput,
  ExportConfirmedCropsInput,
  ExportConfirmedCropsResult,
  ImageAnalysisResult,
  RefineCropInput,
  RefineCropResult,
  SuggestImageNamesBatchInput,
  SuggestImageNamesBatchResult,
  SuggestImageNamesInput,
  SuggestImageNamesResult
} from './image-contracts'
import type { BuildEncodingPreviewInput, EncodingPreviewResult } from './coding-contracts'
import type { ExportGenerationWorkbookInput, ExportGenerationWorkbookResult } from './generation-contracts'

export type BaseFileKind = 'namingFormula' | 'barcodeReference' | 'domesticNaming' | 'productImageMapping'

export interface ProductImageMappingIndex {
  version: string
  sheets: Array<{ name: string; lastOccupiedRow: number; columnWidths?: number[]; appendRow?: number; appendColumn?: number; rowHeights?: Record<number, number> }>
}

export type ResourceStatus = 'ready' | 'missing' | 'not-configured'

export interface BaseFileRecord {
  kind: BaseFileKind
  label: string
  path: string | null
  fileName: string | null
  status: ResourceStatus
  updatedAt: string | null
}

export interface BaseFileUpdateRecord {
  id: string
  /** Records created by one overwrite action share the same batch id. */
  batchId?: string
  /** Internal rollback snapshots remain attached to their original operation. */
  historyRole?: 'overwrite' | 'rollback-safety'
  parentRecordId?: string
  kind: Exclude<BaseFileKind, 'namingFormula'>
  taskName: string
  /** User-facing name follows the generated-product workbook naming rule. */
  operationName?: string
  changeSummary?: string
  sourcePath: string
  sourceFileName: string
  backupPath: string
  createdAt: string
  rolledBackAt: string | null
}

export interface WorkbookPreviewRequest {
  kind: BaseFileKind
  sheetName?: string
  imageStartRow?: number
  imageEndRow?: number
  imagesOnly?: boolean
}

export interface WorkbookPreviewCell {
  hasImage?: boolean
  address: string
  value: string
  formula: string | null
  generatedImageDataUrl: string | null
}

export interface WorkbookPreviewResult {
  kind: BaseFileKind
  fileName: string
  sheetNames: string[]
  activeSheetName: string
  totalRows: number
  dataRowCount: number
  columnCount: number
  rowHeights?: Record<number, number>
  columnWidths?: number[]
  rows: Array<{ rowNumber: number; cells: WorkbookPreviewCell[] }>
}

export type ConnectorKind = 'dingtalk' | 'wecom' | 'generic-http'

export interface ConnectorSummary {
  id: string
  name: string
  kind: ConnectorKind
  enabled: boolean
  configured: boolean
  capabilities: Array<'text' | 'file' | 'link'>
}

export interface AppSnapshot {
  appVersion: string
  baseFiles: Record<BaseFileKind, BaseFileRecord>
  connectors: ConnectorSummary[]
  productTypes: string[]
  seriesTranslations: SeriesTranslation[]
  domesticPatternNames: DomesticPatternNameRecord[]
  productImageMappingIndex?: ProductImageMappingIndex
}

export interface SeriesTranslation {
  chineseName: string
  englishName: string
}

export interface DomesticPatternNameRecord {
  englishName: string
  sheetName: string
  cellAddress: string
}

export type AiProvider = 'aliyun'

export interface AiSettingsSummary {
  provider: AiProvider
  model: string
  baseUrl: string
  configured: boolean
  apiKeyPreview: string | null
}

export interface ApplicationSettings {
  autoSaveDrafts: boolean
  requireQualityCheck: boolean
  allowNetworkFeatures: boolean
}

export type BusinessRole = 'upstream' | 'downstream'

export interface CollaborationUser {
  id: string
  displayName: string
  avatarUrl: string | null
  organizationId: string
  corpId: string
  businessRole: BusinessRole | null
}

export interface CollaborationAccountState {
  status: 'signed-out' | 'signed-in' | 'offline'
  user: CollaborationUser | null
  message: string
}

export interface CollaborationMember {
  id: string
  displayName: string
  avatarUrl: string | null
  lastLoginAt: string
}

export interface CollaborationWorkItem {
  id: string
  title: string
  state: string
  sourceWorkflow: import('./lifecycle-contracts').LifecycleSource
  version: number
  revision: number
  createdAt: string
  lastAction: string | null
  lastReason: string | null
  lastEventAt: string | null
  origin: { id: string; displayName: string }
  assignee: { id: string; displayName: string }
}

export type CollaborationWorkAction = 'claim' | 'return-source' | 'update-stage'

export interface SaveAiSettingsInput {
  provider: AiProvider
  model: string
  baseUrl: string
  apiKey: string
}

export interface TranslateSeriesNameResult {
  englishName: string
  provider: AiProvider
  model: string
}

export interface TaskDraftInput {
  templateName: string
  seriesNameZh: string
  seriesNameEn: string
  ipRemark: string
  selectedModels: string[]
  modelBrandAssignments: Record<string, import('./product-business-rules').PhoneModelBrand>
  /** Stable editable model records used by barcode generation. Legacy drafts fall back to selectedModels. */
  modelSettings?: BarcodeModelSetting[]
  /** Category + frame + brand price defaults. A model-level override has higher priority. */
  framePriceRules?: Record<string, CategoryFramePriceRule>
  masterImagePath: string
}

export interface BarcodePricePair {
  domestic: number | null
  overseas: number | null
}

export interface FramePricePair {
  normal?: BarcodePricePair
  silver?: BarcodePricePair
}

export interface CategoryFramePriceRule extends FramePricePair {
  brands?: Partial<Record<import('./product-business-rules').PhoneModelBrand, FramePricePair>>
}

export interface BarcodeModelSetting {
  id: string
  name: string
  brand: import('./product-business-rules').PhoneModelBrand
  enabled: boolean
  /** Only affects 出镜壳 / 出片壳. */
  silverEnabled: boolean
  pricesByCategory?: Record<string, FramePricePair>
}

export interface TaskDraft extends TaskDraftInput {
  id: string
  createdAt: string
  status: 'draft'
}

export interface SelectFileResult {
  canceled: boolean
  path: string | null
}

export interface ConnectorTestInput {
  connectorId: string
}

export interface ConnectorTestResult {
  ok: boolean
  message: string
}

export interface CasebangDesktopApi {
  lifecycle: import('./lifecycle-contracts').LifecycleApi
  supplement: import('./supplement-contracts').SupplementApi
  app: {
    getSnapshot(): Promise<AppSnapshot>
  }
  settings: {
    get(): Promise<ApplicationSettings>
    save(input: ApplicationSettings): Promise<ApplicationSettings>
  }
  account: {
    get(): Promise<CollaborationAccountState>
    login(businessRole: BusinessRole): Promise<CollaborationAccountState>
    logout(): Promise<CollaborationAccountState>
  }
  collaboration: {
    members(): Promise<CollaborationMember[]>
    workItems(): Promise<CollaborationWorkItem[]>
    publishWorkbook(input: { path: string; title: string; sourceWorkflow: import('./lifecycle-contracts').LifecycleSource }): Promise<{ item: CollaborationWorkItem; duplicate: boolean }>
    submitLifecycle(input: { draftId: string; expectedVersion: number; assigneeId: string }): Promise<{ item: CollaborationWorkItem; duplicate: boolean }>
    act(input: { workItemId: string; action: CollaborationWorkAction; expectedVersion: number; revision: number; state?: string; reason?: string }): Promise<{ item: CollaborationWorkItem; duplicate: boolean }>
    openWorkbook(input: { workItemId: string; title: string; revision: number }): Promise<{ path: string }>
    openOnlineWorkbook(input: { workItemId: string }): Promise<{ opened: true }>
  }
  baseFiles: {
    select(kind: BaseFileKind): Promise<BaseFileRecord>
    preview(input: WorkbookPreviewRequest): Promise<WorkbookPreviewResult>
    history(): Promise<BaseFileUpdateRecord[]>
    rollback(recordId: string): Promise<BaseFileUpdateRecord>
  }
  tasks: {
    selectMasterImage(): Promise<SelectFileResult>
    createDraft(input: TaskDraftInput): Promise<TaskDraft>
    exportGenerationWorkbook(input: ExportGenerationWorkbookInput): Promise<ExportGenerationWorkbookResult>
    publishGenerationWorkbook(input: import('./generation-contracts').PublishGenerationWorkbookInput): Promise<{ item: CollaborationWorkItem; duplicate: boolean }>
  }
  images: {
    analyze(input: AnalyzeMasterImageInput): Promise<ImageAnalysisResult>
    refineCrop(input: RefineCropInput): Promise<RefineCropResult>
    exportCrops(input: ExportConfirmedCropsInput): Promise<ExportConfirmedCropsResult>
  }
  ai: {
    getSettings(): Promise<AiSettingsSummary>
    saveSettings(input: SaveAiSettingsInput): Promise<AiSettingsSummary>
    testConnection(): Promise<{ ok: boolean; message: string }>
    recognizeMaterial(input: import('./material-recognition').MaterialInput): Promise<import('./material-recognition').MaterialResult>
    comparePatterns(input: ComparePatternsInput): Promise<ComparePatternsResult>
    suggestImageNames(input: SuggestImageNamesInput): Promise<SuggestImageNamesResult>
    suggestImageNamesBatch(input: SuggestImageNamesBatchInput): Promise<SuggestImageNamesBatchResult>
    translateSeriesName(input: { chineseName: string }): Promise<TranslateSeriesNameResult>
  }
  integrations: {
    test(input: ConnectorTestInput): Promise<ConnectorTestResult>
  }
  excel: {
    inspectBaseFiles(): Promise<BaseWorkbookInspectionReport>
    cloneTemplateWorkbook(input: CloneTemplateWorkbookInput): Promise<VerifiedWorkbookCloneReport>
    generateTemplateConfig(input: GenerateTemplateConfigInput): Promise<TemplateConfigBundle>
    controlledWrite(input: {
      sourcePath: string
      destinationPath: string
      config: TemplateConfigBundle
      plan: ControlledWritePlan
    }): Promise<ControlledWriteReport>
    buildEncodingPreview(input: BuildEncodingPreviewInput): Promise<EncodingPreviewResult>
  }
}

export const BASE_FILE_DEFINITIONS: Record<
  BaseFileKind,
  { label: string; extensions: string[] }
> = {
  namingFormula: {
    label: '命名-公式',
    extensions: ['xlsx', 'xlsm']
  },
  barcodeReference: {
    label: 'A条码参考',
    extensions: ['xlsx', 'xlsm']
  },
  domesticNaming: {
    label: '国内命名表',
    extensions: ['xlsx', 'xlsm']
  },
  productImageMapping: {
    label: 'K3 名称对应产品图片',
    extensions: ['xlsx']
  }
}
