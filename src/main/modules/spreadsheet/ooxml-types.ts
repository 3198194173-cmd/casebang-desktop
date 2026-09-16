export type WorkbookRole = 'naming-formula' | 'barcode-reference' | 'domestic-naming' | 'unknown'

export type TemplateClassification = 'template' | 'reference' | 'helper'

export interface WorksheetMetrics {
  name: string
  sheetId: string
  state: 'visible' | 'hidden' | 'veryHidden'
  partPath: string
  usedRange: string | null
  formulaCount: number
  styledCellCount: number
  rowCount: number
  customRowHeightCount: number
  columnDefinitionCount: number
  drawingReferenceCount: number
  partCrc32: string
  uncompressedBytes: number
}

export interface TemplateCandidate {
  id: string
  sheetName: string
  classification: TemplateClassification
  reason: string
  sourcePartPath: string
  state: WorksheetMetrics['state']
}

export interface OoxmlComponentFingerprints {
  workbook: string
  worksheets: string
  styles: string
  drawings: string
  media: string
  relationships: string
}

export interface WorkbookInspection {
  role: WorkbookRole
  sourcePath: string
  fileName: string
  fileSize: number
  modifiedAt: string
  sha256: string
  worksheetCount: number
  formulaCount: number
  imageFileCount: number
  imageAnchorCount: number
  styleDefinitionCount: number
  worksheets: WorksheetMetrics[]
  templates: TemplateCandidate[]
  componentFingerprints: OoxmlComponentFingerprints
  warnings: string[]
}

export interface BaseWorkbookInspectionReport {
  generatedAt: string
  namingFormula: WorkbookInspection
  barcodeReference: WorkbookInspection
  domesticNaming: WorkbookInspection
  templateCount: number
  templates: TemplateCandidate[]
}

export interface VerifiedWorkbookCloneReport {
  generatedAt: string
  sourcePath: string
  clonePath: string
  sourceSha256: string
  cloneSha256: string
  exactBinaryMatch: boolean
  checks: {
    formulas: boolean
    styles: boolean
    rowColumnDimensions: boolean
    imageAnchors: boolean
    media: boolean
    relationships: boolean
    worksheetInventory: boolean
  }
  source: WorkbookInspection
  clone: WorkbookInspection
  passed: boolean
}
