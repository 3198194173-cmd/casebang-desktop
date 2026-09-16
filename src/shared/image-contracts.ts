export type CropRole = 'series-overview' | 'product-pattern' | 'unknown'

export const PRODUCT_CATEGORIES = [
  '待确认',
  '磁吸背盖',
  'CP002磁吸充电宝',
  'MP16磁吸充电宝',
  'CP006自带线移动电源',
  '磁吸支架背盖',
  '磁吸气囊支架',
  '出镜壳',
  '出彩壳',
  '出片壳',
  '奇趣壳',
  '推卡卡包',
  'Macbook保护壳',
  'Pad保护壳',
  '镜头膜',
  '流沙磁吸支架背盖',
  '其他'
] as const

export type ProductCategory = string

export interface ImageNameCandidate {
  englishName: string
  chineseName: string
  reason: string
  confidence: number
}

export interface CropBox {
  id: string
  x: number
  y: number
  width: number
  height: number
  role: CropRole
  label: string
  /** 每个产品区域独立保留的产品类型；下游分配编码和写表时不得按图案组合并。 */
  productCategory: ProductCategory
  /** Editable business values used by the generated barcode sheet. */
  suggestedRetailPrice: number | null
  overseasRetailPrice: number | null
  material: string
  /** Tracks whether AI/defaults may still update the value without replacing an operator edit. */
  materialSource?: 'auto' | 'manual'
  /** One wireless artwork shares its PB code across CP002 and MP16. */
  wirelessVariantPrices?: {
    cp002: { retail: number; overseas: number }
    mp16: { retail: number; overseas: number }
  }
  /** 仅用于让相同视觉图案共用名称，不代表合并产品记录。 */
  patternGroupId: string | null
  confidence: number
  categoryConfidence: number | null
  categoryReasons: string[]
  patternNameEn: string
  patternNameZh: string
  nameCandidates: ImageNameCandidate[]
}

export interface ImageAnalysisResult {
  sourceImagePath: string
  fileName: string
  sourceWidth: number
  sourceHeight: number
  format: string
  previewDataUrl: string
  backgroundColor: string
  detectionThreshold: number
  crops: CropBox[]
  warnings: string[]
}

export interface AnalyzeMasterImageInput {
  sourceImagePath: string
}

export interface RefineCropInput {
  sourceImagePath: string
  crop: CropBox
}

export interface RefineCropResult {
  crops: CropBox[]
  message: string
}

export interface SuggestImageNamesInput {
  sourceImagePath: string
  crop: CropBox
  seriesNameZh: string
  seriesNameEn: string
  existingEnglishNames: string[]
  /**
   * 基础资料中的完整历史名称。该列表只在本地校验 AI 结果，不直接拼进提示词，
   * 避免历史数据较多时撑大视觉模型请求。
   */
  forbiddenEnglishNames?: string[]
}

export interface SuggestImageNamesResult {
  candidates: ImageNameCandidate[]
  model: string
}

export interface SuggestImageNamesBatchInput {
  sourceImagePath: string
  crops: CropBox[]
  seriesNameZh: string
  seriesNameEn: string
  existingEnglishNames: string[]
  /** 基础资料中的完整历史名称，仅用于本地去重校验。 */
  forbiddenEnglishNames?: string[]
}

export interface SuggestedCropNames {
  cropId: string
  candidates: ImageNameCandidate[]
}

export interface SuggestImageNamesBatchResult {
  items: SuggestedCropNames[]
  model: string
  warnings?: string[]
}

export interface ExportConfirmedCropsInput {
  sourceImagePath: string
  seriesName: string
  crops: CropBox[]
}

export interface ExportedCropFile {
  cropId: string
  fileName: string
  path: string
  width: number
  height: number
}

export interface ExportConfirmedCropsResult {
  canceled: boolean
  outputDirectory: string | null
  files: ExportedCropFile[]
}
