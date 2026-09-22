export interface ArtworkFilenameMetadata {
  fileName: string
  extension: string
  series: string | null
  category: string | null
  model: string | null
  material: string | null
  productCode: string | null
  patternKey: string | null
  normalizedPatternKey: string | null
}

const PRODUCT_CODE = /\b[A-Z]{1,6}\d{4,}\b/i
const CATEGORY_NAMES = ['可拆卸', '一体壳', '充电宝', '支架', '出镜壳', '出彩壳', '出片壳']
const MATERIAL_NAMES = ['透明片材', '闪粉片材', '银色片材', '磨砂片材', '彩色片材']

/** The workbook stores the authoritative uppercase artwork key. */
export function normalizeArtworkKey(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9\u4E00-\u9FFF]+/g, '')
}

export function parseArtworkFilename(fileName: string): ArtworkFilenameMetadata {
  const match = fileName.trim().match(/^(.*?)(\.[^.]+)?$/)
  const stem = match?.[1] ?? fileName.trim()
  const extension = (match?.[2] ?? '').toLowerCase()
  const parts = stem.split('#').map(part => part.trim()).filter(Boolean)
  const productIndex = parts.findIndex(part => PRODUCT_CODE.test(part))
  const productCode = productIndex >= 0 ? parts[productIndex]!.match(PRODUCT_CODE)?.[0]?.toUpperCase() ?? null : null
  const patternPart = productIndex >= 0 ? parts.slice(productIndex + 1).join('#') : parts.at(-1) ?? null
  const prefix = productIndex >= 0 ? parts.slice(0, productIndex).join('#') : stem
  const seriesParts = productIndex >= 0 ? parts.slice(0, productIndex) : []
  if (seriesParts.length) seriesParts[0] = seriesParts[0]!.split(/[-–—]/).at(-1)!.trim()
  const series = seriesParts.length ? seriesParts.join('#') : null
  const category = CATEGORY_NAMES.find(value => prefix.includes(value)) ?? null
  const material = MATERIAL_NAMES.find(value => prefix.includes(value)) ?? null
  const model = extractModel(prefix)
  const normalizedPatternKey = patternPart ? normalizeArtworkKey(patternPart) : null
  return { fileName, extension, series, category, model, material, productCode, patternKey: patternPart || null, normalizedPatternKey }
}

function extractModel(value: string): string | null {
  const match = value.match(/(?:苹果|iPhone)\s*\d{1,2}\s*(?:PRO\s*MAX|PROMAX|PRO|PLUS|MAX|普通版)?/i)
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null
}
