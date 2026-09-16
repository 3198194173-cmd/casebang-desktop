import type { WorkbookPreviewResult } from '@shared/contracts'
import type { GenerationWorkspaceData, PreviewCell } from '@shared/generation-contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'

export interface ExistingSeriesSelection {
  code: string
  englishName: string
  chineseName: string
  referenceRow: number
  referenceSheet: string
  referenceAppendColumn: number
}
export interface ExistingSeriesTarget {
  sheet: string
  nameRow: number
  appendColumn: number
  names: string[]
}

export interface HistoricalPatternOption {
  id: string
  name: string
  imageDataUrl: string
}
export const excelColumn = (index: number): string => {
  let result = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result
  return result
}
export const columnIndex = (address: string): number => [...address.replace(/\d/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
const normalized = (value: string): string => value.normalize('NFKC').replace(/\s/g, '').toLowerCase()

export function nextOccupiedColumn(preview: WorkbookPreviewResult, rowNumbers: number[]): number {
  return Math.max(0, ...preview.rows.filter(row => rowNumbers.includes(row.rowNumber)).flatMap(row => row.cells.filter(c => c.value.trim() || c.formula || c.hasImage || c.generatedImageDataUrl).map(c => columnIndex(c.address) + 1)))
}

export function findSeriesTargets(preview: WorkbookPreviewResult, series: ExistingSeriesSelection): ExistingSeriesTarget[] {
  return preview.rows.flatMap(row => {
    const header = row.cells.find(cell => normalized(cell.value).includes(normalized(`${series.englishName}#${series.code}系列`)))
    if (!header || row.rowNumber < 2) return []
    // Inspect only this series image/name block; unrelated rows and formatting do not move it.
    const names = row.cells.filter(cell => cell !== header && cell.value && !cell.formula).map(cell => cell.value)
    return [{ sheet: preview.activeSheetName, nameRow: row.rowNumber, appendColumn: nextOccupiedColumn(preview, [row.rowNumber - 1, row.rowNumber]), names }]
  })
}

export function appendExistingSeries(workspace: GenerationWorkspaceData, target: ExistingSeriesTarget, series: ExistingSeriesSelection, categories: Map<string, string>, analysis?: ImageAnalysisResult): GenerationWorkspaceData {
  const domestic = workspace.workbooks.find(w => w.id === 'domestic-naming')!
  const source = domestic.sheets[0]!
  const products = analysis?.crops.filter(c => c.role !== 'series-overview')
  const images: PreviewCell[] = products ? products.map(c => ({ value: '', cropId: c.id, changed: true, imageLayout: { containerWidthPx: 205, containerHeightPx: 170, imageWidthPx: Math.max(1, c.width * Math.min(205 / c.width, 170 / c.height)), imageHeightPx: Math.max(1, c.height * Math.min(205 / c.width, 170 / c.height)) } })) : source.rows[0]!.slice(1)
  const names: PreviewCell[] = products ? products.map(c => ({ value: c.patternNameEn, changed: true })) : source.rows[1]!.slice(1)
  const top: PreviewCell[] = Array.from({ length: target.appendColumn }, () => ({ value: '' }))
  const bottom: PreviewCell[] = top.map(() => ({ value: '' }))
  images.forEach((image, index) => {
    top.push({ ...image }); bottom.push({ ...names[index]! })
  })
  const rows = [top, bottom].map((row, offset) => row.map((cell, column) => cell.changed ? { ...cell, targetAddress: `${excelColumn(column)}${target.nameRow - 1 + offset}` } : cell))
  const reference: PreviewCell[] = Array.from({ length: series.referenceAppendColumn }, () => ({ value: '' }))
  const overview = source.rows[0]?.[0]
  reference.push({ value: [...new Set(images.map(image => categories.get(image.cropId ?? '')).filter(Boolean))].join(' / '), changed: true })
  if (overview?.cropId) reference.push({ ...overview })
  const referenceRow = reference.map((cell, column) => cell.changed ? { ...cell, targetAddress: `${excelColumn(column)}${series.referenceRow}` } : cell)
  const fits = top.length <= 16384 && reference.length <= 16384 && target.nameRow >= 2
  return { ...workspace, workbooks: workspace.workbooks.map(w => w.id === 'domestic-naming'
    ? { ...w, role: '已有系列右侧追加：产品图片及名称；原数据保持不变。', sheets: [{ ...source, name: target.sheet, startRow: target.nameRow - 1, rows, columns: top.map((_, i) => excelColumn(i)), columnWidths: top.map(() => 205) }] }
    : w.id === 'barcode-reference' ? { ...w, sheets: w.sheets.map(s => s.id === 'series-code' ? { ...s, name: series.referenceSheet, startRow: series.referenceRow, showBusinessHeader: false, headerCells: undefined, rows: [referenceRow], columns: reference.map((_, i) => excelColumn(i)), columnWidths: reference.map(() => 190) } : s) } : w),
    checks: [...workspace.checks.map(check => check.id === 'series-code-reserve' ? { ...check, label: '沿用已有系列', passed: true, detail: `${series.englishName} / ${series.code}；原名称和主图不改写，右侧追加本次总图。` } : check), { id: 'existing-append-bounds', label: '已有系列追加位置有效', passed: fits, detail: fits ? '追加位置在源表右侧，保留已有单元格。' : '追加范围超过 Excel 列限制，不能导出。' }] }
}
