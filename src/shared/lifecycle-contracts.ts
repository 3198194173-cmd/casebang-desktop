export type MaterialBrand = 'AP' | 'SA' | 'HW' | 'MI' | 'HON' | 'VV' | 'OP' | 'IQ' | '1+' | 'RM' | 'GG'
export type MaterialCodeBrand = 'AP' | 'SA' | 'HW' | 'MI' | 'VV' | 'OP' | 'IQ' | '1+' | 'GG'
export type BarcodeSource = 'internal_monthly' | 'platform'
export type LifecycleSource = 'new-series' | 'new-products' | 'new-models' | 'manual'
export interface MaterialIdentity {
  category: string
  domain: 'BG' | 'CA' | null
  series: string
  patternName: string
  productCode: string
  modelName: string
  brand: MaterialCodeBrand | null
  modelCode: string | null
  frame: 'normal' | 'silver'
  variant: string
}
export interface LifecycleRow {
  id: string
  sheet: string
  row: number
  nameAddress: string
  barcodeAddress: string
  materialCodeAddress: string
  itemClass: string
  materialName: string
  barcode: string
  materialCode: string
  material: string
  domesticPrice: string
  overseasPrice: string
  remark: string
  identity: MaterialIdentity
  issues: string[]
}
export interface ArtworkSheetRow {
  id: string
  sheet: string
  row: number
  productCode: string
  barcodeName: string
  patternName: string
  patternNameUpper: string
  artworkFileName: string
  /** Thumbnail of the embedded workbook image anchored on this row, when available. */
  imageDataUrl: string | null
}
export interface LifecycleDraft {
  id: string
  title: string
  source: LifecycleSource
  sourcePath: string
  sourceHash: string
  createdAt: string
  /** Account that imported this local snapshot. Legacy/offline drafts may not have an owner yet. */
  ownerUserId?: string | null
  version: number
  rows: LifecycleRow[]
  warnings: string[]
  barcodeSource: BarcodeSource | null
  patternVariants: Record<string, string>
}
export type LifecycleDraftSummary = Pick<LifecycleDraft, 'id' | 'title' | 'source' | 'createdAt' | 'version'> & { rowCount: number; issueCount: number }
export interface LifecycleRowPreview {
  rowId: string
  candidate: string | null
  status: 'existing' | 'candidate' | 'blocked'
  issues: string[]
}
export interface BarcodeAllocationPlan {
  monthPrefix: string
  previousCode: string | null
  nextCode: string
  pendingCount: number
  existingCount: number
  masterFileName: string
}
export interface MaterialPatternPlan {
  key: string
  patternName: string
  productCode: string
  frame: 'normal' | 'silver'
  variant: string | null
  detectedVariant: string | null
  referenceCode: string | null
  rowCount: number
  source: 'master' | 'proposed' | 'manual' | 'conflict' | 'blocked'
  customized: boolean
  issues: string[]
  warnings: string[]
}
export interface SharedLifecycleAnalysis {
  workItemId: string
  title: string
  sourceWorkflow: LifecycleSource
  version: number
  revision: number
  rows: LifecycleRow[]
  /** All user-facing sheets, including the 图片 sheet that is used for artwork comparison. */
  sheetNames: string[]
  artworkRows: ArtworkSheetRow[]
  warnings: string[]
  materialCodePreviews: LifecycleRowPreview[]
  patternVariants: Record<string, string>
  patternPlans: MaterialPatternPlan[]
  barcodePlan: BarcodeAllocationPlan
}
export interface ApplySharedLifecycleInput {
  workItemId: string
  title: string
  sourceWorkflow: LifecycleSource
  expectedVersion: number
  expectedRevision: number
  monthPrefix: string
  fillBarcodes: boolean
  fillMaterialCodes: boolean
  patternVariants: Record<string, string>
  patternOverrideEnabled?: boolean
  patternOverrideReason?: string
}
export interface SharedLifecycleWriteResult {
  item: import('./contracts').CollaborationWorkItem
  barcodeFilled: number
  materialCodeFilled: number
}
export interface MaterialMasterPreview {
  path: string
  fileName: string
  totalRows: number
  page: number
  pageSize: number
  rows: LifecycleRow[]
}
export interface SaveMaterialModelInput {
  originalBrand?: MaterialBrand
  originalCode?: string
  brand: MaterialBrand
  code: string
  name: string
  aliases: string[]
}
export interface LifecycleApi {
  list(): Promise<LifecycleDraftSummary[]>
  importWorkbook(): Promise<LifecycleDraft | null>
  inspectWorkbook(input: { path: string }): Promise<{ warnings: string[]; sheetNames: string[] }>
  get(id: string): Promise<LifecycleDraft>
  save(input: { id: string; expectedVersion: number; barcodeSource: BarcodeSource | null; patternVariants: Record<string, string> }): Promise<LifecycleDraft>
  preview(id: string): Promise<LifecycleRowPreview[]>
  analyzeShared(input: { workItemId: string; title: string; sourceWorkflow: LifecycleSource; version: number; revision: number; monthPrefix: string; patternVariants?: Record<string, string>; patternOverrideEnabled?: boolean; patternOverrideReason?: string }): Promise<SharedLifecycleAnalysis>
  applyShared(input: ApplySharedLifecycleInput): Promise<SharedLifecycleWriteResult>
  previewMaterialMaster(input: { page: number; pageSize: number; query?: string }): Promise<MaterialMasterPreview>
  listMaterialModels(): Promise<import('./material-model-dictionary').MaterialModel[]>
  saveMaterialModel(input: SaveMaterialModelInput): Promise<import('./material-model-dictionary').MaterialModel[]>
}
