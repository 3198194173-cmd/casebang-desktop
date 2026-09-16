import type { ProductImageMappingIndex, TaskDraftInput } from '@shared/contracts'
import type { PreviewCell, PreviewSheet, PreviewWorkbook } from '@shared/generation-contracts'
import type { CropBox } from '@shared/image-contracts'
import { isPairedWireless, productBusinessSpecification } from '@shared/product-business-rules'

interface ProductRow { crop: CropBox; barcode: string; code: string }

/** Only routes this task's outputs; K3 never supplies names, prices or codes. */
export function buildProductImageMapping(form: TaskDraftInput, seriesCode: string, products: ProductRow[], index: ProductImageMappingIndex): PreviewWorkbook {
  const existing = new Map(index.sheets.map((sheet) => [sheet.name, sheet.lastOccupiedRow]))
  const groups = new Map<string, { rows: ProductRow[]; fresh: boolean; wireless: boolean; detail: boolean }>()
  for (const row of products) {
    const category = row.crop.productCategory
    const spec = productBusinessSpecification(category)
    let name: string
    let fresh = false
    let detail = true
    const wireless = isPairedWireless(category)
    if (wireless) name = '充电宝名字图案对应'
    else if (/自带线/.test(category)) name = /CP01(?!\d)/i.test(category) ? '自带线充电宝图片+名称' : 'CP006自带线充电宝名字图案对应'
    else if (/卡包支架|方片材/.test(category)) name = '方片材名字图案对应'
    else if (spec.itemClass === '支架') name = '圆片材＆气囊支架名字图案对应'
    else if (/挂绳|挂件|背带|侧挂/.test(category)) name = '挂绳类图片+名称'
    else if (/礼盒/.test(category)) name = '礼盒图片+名称'
    else if (/奇趣壳/.test(category)) name = '奇趣壳图片+名称'
    else if (/磁吸背盖|出镜壳|出彩壳|出片壳/.test(category)) {
      const label = /磁吸背盖/.test(category) ? '可拆卸' : category
      const suffix = `#${seriesCode}${label}图片+名称`
      const seriesName = form.seriesNameZh.trim() || form.seriesNameEn.trim()
      name = `${seriesName.slice(0, 31 - suffix.length)}${suffix}`
      fresh = true
      detail = false
    } else name = form.ipRemark ? '其他联名产品图片+名称' : '其他产品图片+名称'
    const group = groups.get(name) ?? { rows: [], fresh, wireless, detail }
    group.rows.push(row)
    groups.set(name, group)
  }
  const sheets: PreviewSheet[] = []
  for (const [requestedName, group] of groups) {
    let name = requestedName
    if (group.fresh) name = uniqueSheetName(name, existing)
    const createIfMissing = !existing.has(name)
    const historical = index.sheets.find((sheet) => sheet.name === name)
    const startRow = historical?.appendRow ?? (existing.get(name) ?? 0) + 1
    const startColumn = historical?.appendColumn ?? 0
    const rows: PreviewCell[][] = []
    const rowHeights: number[] = []
    const historicalWidths = index.sheets.find((sheet) => sheet.name === name)?.columnWidths
    const widthLimit = historicalWidths?.findIndex((width) => width < 100) ?? -1
    const availableColumns = widthLimit > 0 ? widthLimit : historical ? 12 : group.wireless ? 12 : 10
    const columns = group.wireless ? Math.max(2, Math.min(12, availableColumns - availableColumns % 2)) : Math.min(12, availableColumns)
    if (startColumn >= columns || (group.wireless && startColumn % 2 !== 0)) throw new Error(`分表“${name}”的续填位置无效，请刷新基础资料。`)
    if (group.wireless) {
      const byCrop = new Map<string, ProductRow[]>()
      for (const row of group.rows) byCrop.set(row.crop.id, [...(byCrop.get(row.crop.id) ?? []), row])
      const pairs = [...byCrop.values()]
      for (let offset = 0; offset < pairs.length;) {
        const padding = offset === 0 ? startColumn : 0
        const imageRow: PreviewCell[] = Array.from({ length: padding }, () => ({ value: '' }))
        const nameRow: PreviewCell[] = Array.from({ length: padding }, () => ({ value: '' }))
        const batch = pairs.slice(offset, offset + (columns - padding) / 2)
        for (const pair of batch) {
          const cp = pair.find((row) => row.crop.productCategory.startsWith('CP002'))!
          const mp = pair.find((row) => row.crop.productCategory.startsWith('MP16'))!
          imageRow.push(picture(cp.crop), text('', true))
          nameRow.push(text(cp.barcode), text(mp.barcode))
        }
        rows.push(imageRow, nameRow)
        rowHeights.push(220, 100)
        offset += batch.length
      }
    } else {
      // Stand order is explicit, independent of incoming detection order.
      const ordered = [...group.rows].sort((a, b) => Number(/气囊/.test(a.crop.productCategory)) - Number(/气囊/.test(b.crop.productCategory)))
      for (let offset = 0; offset < ordered.length;) {
        const padding = offset === 0 ? startColumn : 0
        const blanks = (): PreviewCell[] => Array.from({ length: padding }, () => ({ value: '' }))
        const batch = ordered.slice(offset, offset + columns - padding)
        rows.push([...blanks(), ...batch.map((row) => picture(row.crop))], [...blanks(), ...batch.map((row) => text(row.barcode))])
        rowHeights.push(220, 90)
        // Reserve the existing caption row without generating separate Chinese text.
        if (group.detail) { rows.push([...blanks(), ...batch.map(() => text('', true))]); rowHeights.push(54) }
        offset += batch.length
      }
    }
    const columnCount = Math.max(...rows.map((row) => row.length))
    const columnWidths = Array.from({ length: columnCount }, (_, column) => historicalWidths?.[column] ?? 205)
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, column) => {
        if (!cell.cropId && cell.value) {
          const textPixels = [...cell.value].reduce((total, character) => total + (character.charCodeAt(0) > 255 ? 16 : 8), 0)
          const height = (Math.ceil(textPixels / Math.max(60, columnWidths[column]! - 12)) + 1) * 20
          rowHeights[rowIndex] = Math.max(rowHeights[rowIndex]!, height)
        }
      })
    })
    rowHeights.forEach((_, rowIndex) => {
      const originalHeight = historical?.rowHeights?.[startRow + rowIndex]
      if (originalHeight) rowHeights[rowIndex] = originalHeight
    })
    rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
      if (!cell.imageLayout) return
      const layout = cell.imageLayout
      const ratio = Math.min((columnWidths[column]! - 10) / layout.imageWidthPx, (rowHeights[rowIndex]! - 10) / layout.imageHeightPx)
      layout.imageWidthPx *= ratio
      layout.imageHeightPx *= ratio
      layout.containerWidthPx = columnWidths[column]!
      layout.containerHeightPx = rowHeights[rowIndex]!
    }))
    sheets.push({ id: `k3-${sheets.length + 1}`, name, startRow, createIfMissing, showBusinessHeader: false,
      columns: Array.from({ length: columnCount }, (_, i) => String.fromCharCode(65 + i)), rows,
      columnWidths, rowHeights })
    existing.set(name, startRow + rows.length - 1)
  }
  return { id: 'product-image-mapping', name: 'K3 名称对应产品图片', role: '本次产品图片与物料名称，按品类追加或新建分表；独立中文说明留空。', sheets, sourceVersion: index.version }
}

function text(value: string, yellow = false): PreviewCell { return { value, changed: true, ...(yellow ? { fill: 'yellow' as const } : {}) } }
function picture(crop: CropBox): PreviewCell {
  const ratio = Math.min(195 / crop.width, 210 / crop.height)
  return { value: '', changed: true, cropId: crop.id, imageLayout: { containerWidthPx: 205, containerHeightPx: 220, imageWidthPx: crop.width * ratio, imageHeightPx: crop.height * ratio } }
}
function uniqueSheetName(source: string, existing: Map<string, number>): string {
  const safe = source.replace(/[\\/\[\]:*?]/g, '-').replace(/^'+|'+$/g, '').trim() || '新系列图片名称'
  const names = new Set([...existing.keys()].map((name) => name.toLocaleLowerCase()))
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? '' : ` (${number})`
    const candidate = safe.slice(0, 31 - suffix.length) + suffix
    if (!names.has(candidate.toLocaleLowerCase())) return candidate
  }
}
