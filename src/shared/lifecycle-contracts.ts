export type MaterialBrand = 'AP' | 'SA' | 'HW'
export type BarcodeSource = 'internal_monthly' | 'platform'
export type LifecycleSource = 'new-series' | 'new-products' | 'new-models' | 'manual'
export interface MaterialIdentity {
  category: string
  domain: 'BG' | 'CA' | null
  series: string
  patternName: string
  productCode: string
  modelName: string
  brand: MaterialBrand | null
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
export interface SharedLifecycleAnalysis {
  workItemId: string
  title: string
  version: number
  revision: number
  rows: LifecycleRow[]
  warnings: string[]
  materialCodePreviews: LifecycleRowPreview[]
  barcodePlan: BarcodeAllocationPlan
}
export interface ApplySharedLifecycleInput {
  workItemId: string
  title: string
  expectedVersion: number
  expectedRevision: number
  monthPrefix: string
  fillBarcodes: boolean
  fillMaterialCodes: boolean
  patternVariants: Record<string, string>
  openOnlineAfterSave?: boolean
}
export interface SharedLifecycleWriteResult {
  item: import('./contracts').CollaborationWorkItem
  barcodeFilled: number
  materialCodeFilled: number
  openedOnline: boolean
}
export interface LifecycleApi {
  list(): Promise<LifecycleDraftSummary[]>
  importWorkbook(): Promise<LifecycleDraft | null>
  get(id: string): Promise<LifecycleDraft>
  save(input: { id: string; expectedVersion: number; barcodeSource: BarcodeSource | null; patternVariants: Record<string, string> }): Promise<LifecycleDraft>
  preview(id: string): Promise<LifecycleRowPreview[]>
  analyzeShared(input: { workItemId: string; title: string; version: number; revision: number; monthPrefix: string; patternVariants?: Record<string, string> }): Promise<SharedLifecycleAnalysis>
  applyShared(input: ApplySharedLifecycleInput): Promise<SharedLifecycleWriteResult>
}
