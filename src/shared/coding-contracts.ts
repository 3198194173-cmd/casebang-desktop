import type { SeriesCodeReservePlan } from './series-code'

export interface EncodingCropInput {
  cropId: string
  productCategory: string
  patternGroupId: string | null
  patternNameEn: string
}

export interface BuildEncodingPreviewInput {
  seriesNameZh: string
  seriesNameEn: string
  crops: EncodingCropInput[]
}

export interface EncodingPoolSummary {
  header: string
  column: string
  prefixes: string[]
  usedCount: number
  latestCode: string | null
  usedCodes: string[]
}

export interface EncodingPreviewRow {
  cropId: string
  order: number
  productCategory: string
  patternGroupId: string | null
  patternNameEn: string
  poolHeader: string | null
  poolColumn: string | null
  prefix: string | null
  previousLatestCode: string | null
  productCode: string
  status: 'ready' | 'unmapped' | 'conflict'
  message: string
}

export interface EncodingPreviewResult {
  generatedAt: string
  seriesCode: string
  recommendedSeriesCode: string
  seriesCodeWithSuffix: string
  seriesCodeStatus: 'existing' | 'new'
  seriesCodeMessage: string
  usedSeriesCodes: string[]
  seriesCodeReservePlan: SeriesCodeReservePlan
  rows: EncodingPreviewRow[]
  pools: EncodingPoolSummary[]
  warnings: string[]
  referencePreview?: {
    seriesSheetName: string
    seriesRows: Array<{ row: number; values: string[] }>
    usedCodeSheetName: string
    usedCodeHeaderRow: number
    usedCodeRows: Array<{ row: number; values: string[] }>
  }
}
