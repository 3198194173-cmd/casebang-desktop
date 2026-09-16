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

export interface CloneTemplateWorkbookInput {
  sourcePath: string
  destinationPath: string
}

export type TemplateFieldKey =
  | 'barcodeName'
  | 'image'
  | 'color'
  | 'seriesName'
  | 'seriesNameUppercase'
  | 'seriesCode'
  | 'productCode'
  | 'patternName'
  | 'patternNameUppercase'
  | 'finalName'

export type TemplateFieldWriteMode = 'value' | 'formula' | 'readonly'

export interface TemplateFieldBinding {
  field: TemplateFieldKey
  label: string
  column: string
  columnIndex: number
  header: string
  headerCell: string
  writeMode: TemplateFieldWriteMode
  confidence: number
  sampleFormula: string | null
}

export interface GeneratedTemplateConfig {
  id: string
  sheetName: string
  sheetPartPath: string
  headerRow: number
  usedRange: string | null
  sourcePartCrc32: string
  fields: TemplateFieldBinding[]
  allowedWriteFields: TemplateFieldKey[]
  warnings: string[]
}

export interface TemplateConfigBundle {
  schemaVersion: 1
  generatedAt: string
  sourcePath: string
  sourceSha256: string
  templates: GeneratedTemplateConfig[]
  warnings: string[]
}

export type ControlledCellValue = string | number | boolean | null

export interface ControlledRowWrite {
  row: number
  values: Partial<Record<TemplateFieldKey, ControlledCellValue>>
}

export interface ControlledWritePlan {
  sheetName: string
  rows: ControlledRowWrite[]
}

export interface ControlledWriteRequest extends ControlledWritePlan {
  sourcePath: string
  destinationPath: string
  config: TemplateConfigBundle
}

export interface PackageEntryDifference {
  path: string
  kind: 'added' | 'removed' | 'changed'
}

export interface ControlledWriteReport {
  generatedAt: string
  sourcePath: string
  destinationPath: string
  sheetName: string
  sheetPartPath: string
  changedCells: string[]
  changedEntries: PackageEntryDifference[]
  checks: {
    sourceMatchesConfig: boolean
    onlyApprovedEntriesChanged: boolean
    formulasPreserved: boolean
    cellStylesPreserved: boolean
    rowColumnDimensionsPreserved: boolean
    imageReferencesPreserved: boolean
    stylesPartPreserved: boolean
    drawingsPreserved: boolean
    mediaPreserved: boolean
    relationshipsPreserved: boolean
  }
  warnings: string[]
  passed: boolean
}

export interface GenerateTemplateConfigInput {
  sourcePath: string
}
