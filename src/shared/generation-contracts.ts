export interface PreviewCell {
  historicalImageDataUrl?: string
  value: string
  /** Optional typed Excel value. `value` remains the formatted preview text. */
  numericValue?: number
  /** Exact Excel coordinate shown in step 04 and consumed unchanged in step 05. */
  targetAddress?: string
  formula?: string
  cropId?: string
  changed?: boolean
  /** Write to the export copy without presenting the cell as a new user value. */
  writeOnly?: boolean
  fill?: 'yellow'
  imageLayout?: {
    containerWidthPx: number
    containerHeightPx: number
    imageWidthPx: number
    imageHeightPx: number
    /** Stretch is reserved for table cells whose business rule requires edge-to-edge artwork. */
    fitMode?: 'contain' | 'stretch'
  }
}

export interface PreviewSheet {
  id: string
  name: string
  columns: string[]
  /** Optional controlled cells on the source worksheet's header row. */
  headerCells?: PreviewCell[]
  rows: PreviewCell[][]
  startRow?: number
  showBusinessHeader?: boolean
  columnWidths?: number[]
  rowHeights?: number[]
  createIfMissing?: boolean
}

export interface PreviewWorkbook {
  id: 'barcode-reference' | 'domestic-naming' | 'generated-product' | 'product-image-mapping'
  name: string
  role: string
  sheets: PreviewSheet[]
  sourceVersion?: string
}

export interface GenerationQualityCheck {
  id: string
  label: string
  passed: boolean
  detail: string
}

export interface GenerationWorkspaceData {
  title: string
  generatedAt: string
  workbooks: PreviewWorkbook[]
  checks: GenerationQualityCheck[]
}

export interface ExportGenerationWorkbookInput {
  suggestedName: string
  workspace: GenerationWorkspaceData
  sourcePaths: {
    namingFormula: string
    barcodeReference: string
    domesticNaming: string
    productImageMapping?: string
  }
  templateName: string
  imageSource: {
    path: string
    crops: Array<{ id: string; x: number; y: number; width: number; height: number }>
  }
  selectedWorkbookIds?: PreviewWorkbook['id'][]
  overwriteBaseFiles?: boolean
}

export interface ExportGenerationWorkbookResult {
  canceled: boolean
  outputPath: string | null
  fileName: string | null
  files?: Array<{ label: string; path: string; fileName: string }>
  overwritten?: Array<{ label: string; path: string; historyId: string }>
  skipped?: Array<{ label: string; reason: string }>
}

export interface PublishGenerationWorkbookInput {
  generation: ExportGenerationWorkbookInput
  sourceWorkflow: 'new-series' | 'new-products'
}
