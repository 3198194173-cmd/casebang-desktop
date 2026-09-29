import { normalizeProductCategory, phoneModelBrand, type PhoneModelBrand } from './product-business-rules'

export type FrameReferenceVariant = 'normal' | 'silver'
type FrameReferenceCategory = '出镜壳' | '出片壳'

/** Unlike optional user overrides, every workbook reference price is complete. */
export interface FrameReferencePrice {
  domestic: number
  overseas: number
}

export interface FrameReferenceModel {
  readonly name: string
  readonly brand: PhoneModelBrand
  /** Black frame: material names intentionally have no frame suffix. */
  readonly normal: Readonly<FrameReferencePrice>
  readonly silver?: Readonly<FrameReferencePrice>
  readonly aliases?: readonly string[]
}

/**
 * Verified against the actual material-name and price rows (D/E/F), not the
 * incomplete L/N/O model-side lists. The “3个/2个/1个” sheets repeat products;
 * they do not define different unit prices or separate model catalogues.
 */
export const FRAME_REFERENCE_SOURCE = Object.freeze({
  fileName: 'A条码参考-260928.xlsx',
  sheets: Object.freeze(['出镜壳', '出镜壳3个', '出镜壳 2个', '出镜壳 1个', '出片壳', '出片壳 3个']),
  modelColumn: 'D',
  domesticPriceColumn: 'E',
  overseasPriceColumn: 'F',
  analysedRowCount: 799,
  conflictingPriceCount: 0,
  rowsBySheet: Object.freeze({
    出镜壳: Object.freeze({ normal: 204, silver: 40 }),
    出镜壳3个: Object.freeze({ normal: 153, silver: 30 }),
    '出镜壳 2个': Object.freeze({ normal: 102, silver: 20 }),
    '出镜壳 1个': Object.freeze({ normal: 51, silver: 10 }),
    出片壳: Object.freeze({ normal: 68, silver: 40 }),
    '出片壳 3个': Object.freeze({ normal: 51, silver: 30 })
  })
})

export const FRAME_REFERENCE_STATISTICS = Object.freeze({
  出镜壳: Object.freeze({
    normalModelCount: 51,
    silverModelCount: 10,
    normalRowCount: 510,
    silverRowCount: 100,
    normalPriceGroups: Object.freeze([
      Object.freeze({ domestic: 149, overseas: 31.99, modelCount: 20 }),
      Object.freeze({ domestic: 129, overseas: 28.99, modelCount: 31 })
    ]),
    silverPriceGroups: Object.freeze([Object.freeze({ domestic: 169, overseas: 36.99, modelCount: 10 })])
  }),
  出片壳: Object.freeze({
    normalModelCount: 17,
    silverModelCount: 10,
    normalRowCount: 119,
    silverRowCount: 70,
    normalPriceGroups: Object.freeze([Object.freeze({ domestic: 149, overseas: 31.99, modelCount: 17 })]),
    silverPriceGroups: Object.freeze([Object.freeze({ domestic: 169, overseas: 36.99, modelCount: 10 })])
  })
})

const NORMAL_APPLE_PRICE = Object.freeze({ domestic: 149, overseas: 31.99 })
const NORMAL_OTHER_PRICE = Object.freeze({ domestic: 129, overseas: 28.99 })
const SILVER_PRICE = Object.freeze({ domestic: 169, overseas: 36.99 })

// Preserve the main workbook's model order here. The UI/generator separately
// applies the established Apple → Samsung → Huawei → Other brand-block order.
const APPLE_MODELS: readonly FrameReferenceModel[] = Object.freeze([
  model('iP13 Pro', NORMAL_APPLE_PRICE),
  model('iP13 Pro Max', NORMAL_APPLE_PRICE),
  model('iP14 Pro', NORMAL_APPLE_PRICE, true),
  model('iP14 Pro Max', NORMAL_APPLE_PRICE, true),
  model('iP15', NORMAL_APPLE_PRICE),
  model('iP15 Pro', NORMAL_APPLE_PRICE, true),
  model('iP15 Pro Max', NORMAL_APPLE_PRICE, true),
  model('iP16', NORMAL_APPLE_PRICE),
  model('iP16 Plus', NORMAL_APPLE_PRICE),
  model('iP16 Pro', NORMAL_APPLE_PRICE, true),
  model('iP16 Pro Max', NORMAL_APPLE_PRICE, true),
  model('iP16e/17e', NORMAL_APPLE_PRICE),
  model('iP17', NORMAL_APPLE_PRICE, true),
  model('iP17 Air', NORMAL_APPLE_PRICE, true),
  model('iP18 Pro/17 Pro', NORMAL_APPLE_PRICE, true, ['iP18 Pro', 'iP17 Pro']),
  model('iP18 Pro Max/17 Pro Max', NORMAL_APPLE_PRICE, true, ['iP18 Pro Max', 'iP17 Pro Max']),
  model('iP Fold（Duo）', NORMAL_APPLE_PRICE)
])

const MIRROR_MODELS: readonly FrameReferenceModel[] = Object.freeze([
  ...APPLE_MODELS,
  model('MI 15', NORMAL_OTHER_PRICE, false, ['Xiaomi 15']),
  model('MI 15 Pro', NORMAL_OTHER_PRICE, false, ['Xiaomi 15 Pro']),
  model('MI 15U', NORMAL_OTHER_PRICE, false, ['MI 15 Ultra', 'Xiaomi 15 Ultra']),
  model('HW Mate 70', NORMAL_OTHER_PRICE),
  model('HW Mate 70 Pro', NORMAL_OTHER_PRICE),
  model('HW Mate 70 RS', NORMAL_OTHER_PRICE),
  model('HW Mate X6', NORMAL_OTHER_PRICE),
  // These three Huawei models are 149/31.99 in all four actual mirror sheets,
  // unlike the other Huawei models at 129/28.99. Do not use a blanket brand price.
  model('HW PX View', NORMAL_APPLE_PRICE),
  model('HW Mate 90/90 Pro', NORMAL_APPLE_PRICE),
  model('HW Mate 90 Pro Max', NORMAL_APPLE_PRICE),
  model('HON Magic 7', NORMAL_OTHER_PRICE, false, ['Honor Magic 7']),
  model('HON Magic 7 Pro', NORMAL_OTHER_PRICE, false, ['Honor Magic 7 Pro']),
  model('SAM S25', NORMAL_OTHER_PRICE, false, ['Samsung S25']),
  model('SAM S25+', NORMAL_OTHER_PRICE, false, ['Samsung S25+', 'SAM S25 Plus', 'Samsung S25 Plus']),
  model('SAM S25U', NORMAL_OTHER_PRICE, false, ['Samsung S25U', 'SAM S25 Ultra', 'Samsung S25 Ultra']),
  model('SAM A56-5G', NORMAL_OTHER_PRICE, false, ['Samsung A56-5G']),
  model('VV x200', NORMAL_OTHER_PRICE, false, ['Vivo x200']),
  model('VV x200 Pro', NORMAL_OTHER_PRICE, false, ['Vivo x200 Pro']),
  model('VV x200 Pro mini', NORMAL_OTHER_PRICE, false, ['Vivo x200 Pro mini']),
  model('VV x200S', NORMAL_OTHER_PRICE, false, ['Vivo x200S']),
  // The side list abbreviates this as “VV x200 U”; it is the same model, not
  // an extra barcode row. Use the actual D-column spelling when generating.
  model('VV x200 Ultra', NORMAL_OTHER_PRICE, false, ['VV x200 U', 'Vivo x200 Ultra', 'Vivo x200 U']),
  model('HON 300', NORMAL_OTHER_PRICE, false, ['Honor 300']),
  model('HON 300 Pro', NORMAL_OTHER_PRICE, false, ['Honor 300 Pro']),
  model('HON 300 Ultra', NORMAL_OTHER_PRICE, false, ['Honor 300 Ultra']),
  model('OP Find X8', NORMAL_OTHER_PRICE, false, ['OPPO Find X8']),
  model('OP Find X8 Pro', NORMAL_OTHER_PRICE, false, ['OPPO Find X8 Pro']),
  model('OP Find X8 Ultra', NORMAL_OTHER_PRICE, false, ['OPPO Find X8 Ultra']),
  model('OP Find X8 S', NORMAL_OTHER_PRICE, false, ['OPPO Find X8 S']),
  model('OP Find X8 S+', NORMAL_OTHER_PRICE, false, ['OPPO Find X8 S+']),
  model('IQ 13', NORMAL_OTHER_PRICE, false, ['iQOO 13']),
  model('1+ 13', NORMAL_OTHER_PRICE, false, ['OnePlus 13']),
  model('RM K80', NORMAL_OTHER_PRICE, false, ['Redmi K80']),
  model('RM K80 Pro', NORMAL_OTHER_PRICE, false, ['Redmi K80 Pro']),
  model('GG 9A', NORMAL_OTHER_PRICE, false, ['Google 9A'])
])

const MODELS_BY_CATEGORY = Object.freeze({ 出镜壳: MIRROR_MODELS, 出片壳: APPLE_MODELS })
const LOOKUPS = Object.fromEntries(Object.entries(MODELS_BY_CATEGORY).map(([category, models]) => [
  category,
  new Map(models.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])].map((name) => [normalizeModelName(name), entry] as const)))
])) as Record<FrameReferenceCategory, Map<string, FrameReferenceModel>>

/** Return immutable source records; null means this category has no frame reference. */
export function referenceFrameModels(category: string): readonly FrameReferenceModel[] | null {
  const key = referenceCategory(category)
  return key ? MODELS_BY_CATEGORY[key] : null
}

/** Exact or explicitly known alias matching; unrelated/unknown models stay unknown. */
export function referenceFrameModel(category: string, name: string): FrameReferenceModel | undefined {
  const key = referenceCategory(category)
  return key ? LOOKUPS[key].get(normalizeModelName(name)) : undefined
}

/** Return a copy so editing a price never mutates the workbook-derived reference. */
export function referenceFramePrice(category: string, name: string, frame: FrameReferenceVariant): FrameReferencePrice | undefined {
  const record = referenceFrameModel(category, name)
  const price = frame === 'silver' ? record?.silver : record?.normal
  return price ? { ...price } : undefined
}

/** Newly added models/unsupported variants retain the editable category fallback. */
export function referenceFrameFallbackPrice(_category: string, frame: FrameReferenceVariant): FrameReferencePrice {
  return { ...(frame === 'silver' ? SILVER_PRICE : NORMAL_APPLE_PRICE) }
}

function referenceCategory(category: string): FrameReferenceCategory | null {
  const normalized = normalizeProductCategory(category)
  if (normalized.includes('出镜壳')) return '出镜壳'
  if (normalized.includes('出片壳') || normalized === '出片材') return '出片壳'
  return null
}

function normalizeModelName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('en-US')
}

function model(name: string, normal: Readonly<FrameReferencePrice>, silver = false, aliases: readonly string[] = []): FrameReferenceModel {
  const isHuawei = /^HW\s/i.test(name)
  const inferredAliases = isHuawei ? [name.replace(/^HW\s/i, ''), name.replace(/^HW\s/i, 'Huawei ')]
    : /^iP/i.test(name) ? [name.replace(/^iP/i, 'iPhone ')] : []
  return Object.freeze({
    name,
    brand: isHuawei ? 'huawei' : phoneModelBrand(name),
    normal,
    ...(silver ? { silver: SILVER_PRICE } : {}),
    ...(aliases.length || inferredAliases.length ? { aliases: Object.freeze([...inferredAliases, ...aliases]) } : {})
  })
}
