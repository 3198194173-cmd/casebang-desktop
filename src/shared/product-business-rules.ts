export interface ProductBusinessSpecification {
  section: string
  itemClass: string
  suggestedRetailPrice: number | null
  overseasRetailPrice: number | null
  expandsByModel: boolean
  materialNameSuffix?: string
}

export interface BarcodePricePreset {
  suggestedRetailPrice: number
  overseasRetailPrice: number
  label: string
}

/**
 * High-frequency price pairs extracted from
 * “CASEBANG 物料名称汇总-260813（含建议零售价）.xlsx”.
 *
 * The list is intentionally curated rather than exhaustive: operators can
 * still type a price that is not present in the reference workbook.
 */
export const BARCODE_PRICE_PRESETS: readonly BarcodePricePreset[] = [
  pricePreset(89, 19.99, '单个片材常用'),
  pricePreset(129, 28.99, '一体壳常用'),
  pricePreset(149, 31.99, '一体壳进阶'),
  pricePreset(169, 36.99, '一体壳 / 自带线常用'),
  pricePreset(99, 20.99, '奇趣壳 / 卡包常用'),
  pricePreset(199, 42.99, '出彩壳 / 礼盒常用'),
  pricePreset(59, 12.99, '气囊支架常用'),
  pricePreset(49, 9.99, '支架常用'),
  pricePreset(239, 51.99, 'CP002 无线充常用'),
  pricePreset(299, 63.99, 'MP16 无线充常用'),
  pricePreset(69, 14.99, '挂绳 / 配件常用'),
  pricePreset(399, 85.99, '礼盒套装常用'),
  pricePreset(219, 46.99, '壳体加片材套装'),
  pricePreset(39, 8.99, '盲盒常用')
] as const

/** Values most often used as the source workbook's colour/material remark. */
export const MATERIAL_COLOR_OPTIONS = [
  '银色片材', '透明片材', '透明', '银色', '镜面片材', '闪粉片材', '闪粉', '镜面',
  '气囊支架-透明', '贝母', '贝母片材', '银色镜面片材', '金色镜面片材',
  '气囊支架-透闪粉', '气囊支架-透蓝', '蓝色', '银色镜面', '黑色', '粉色',
  '3D空心片材', '蓝框', '黑框', '粉框', '流沙', '金色片材', '黑色实心片材',
  '银色（贴钻工艺）', '透闪粉', '透蓝'
] as const

/** Barcode item classes observed in the material master workbook. */
export const BARCODE_ITEM_CLASSES = [
  '单个片材', '一体壳', '礼盒套装', '支架', '无线充', '自带线', '挂绳',
  '可拆卸保护壳壳体', '配件', '可拆卸壳体+片材', '盲盒', '卡包', '单个壳体', '挂件'
] as const

/** Models extracted from the reference workbook's magnetic-back-cover material names. */
export const REFERENCE_PHONE_MODELS = [
  'iP13 Pro', 'iP13 Pro Max', 'iP14 Pro', 'iP14 Pro Max', 'iP15', 'iP15 Plus', 'iP15 Pro', 'iP15 Pro Max',
  'iP16', 'iP16 Plus', 'iP16 Pro', 'iP16 Pro Max', 'iP16e/17e', 'iP17', 'iP17 Air', 'iP18 Pro/17 Pro', 'iP18 Pro Max/17 Pro Max',
  'SAM S24', 'SAM S24+', 'SAM S24U', 'SAM S25U', 'SAM S26', 'SAM S26+', 'SAM S26U', 'SAM Z Fold8',
  'P70', 'P70 Pro/Pro+', 'P70 Ultra', 'P80 Pro/Pro+', 'P80 Ultra', 'Mate 60', 'Mate 60 Pro', 'Mate 70 Pro/Pro+',
  'Mate 80/80 Pro', 'Mate 80 Pro Max', 'PX Max', 'P90 Pro', 'P90 Pro Max'
] as const

export type PhoneModelBrand = 'apple' | 'huawei' | 'samsung' | 'other'

/** Barcode-sheet order observed in the reference product workbook. */
export const BARCODE_MODEL_BRAND_ORDER: readonly PhoneModelBrand[] = ['apple', 'samsung', 'huawei', 'other']

export function phoneModelBrand(model: string): PhoneModelBrand {
  const normalized = model.normalize('NFKC').trim().toLocaleLowerCase('en-US')
  if (/^(?:ip|iphone)/.test(normalized)) return 'apple'
  if (/^(?:sam|samsung|galaxy)/.test(normalized)) return 'samsung'
  if (/^(?:huawei|mate\b|nova\b|px\b|p\d)/.test(normalized)) return 'huawei'
  return 'other'
}

export function isPairedWireless(category: string): boolean {
  return /CP002|MP16|磁吸充电宝/i.test(category) && !/自带线/.test(category)
}

export function wirelessPrices(crop: { productCategory: string; suggestedRetailPrice: number | null; overseasRetailPrice: number | null; wirelessVariantPrices?: { cp002: { retail: number; overseas: number }; mp16: { retail: number; overseas: number } } }) {
  const cp002 = { retail: 239, overseas: 51.99 }
  const mp16 = { retail: 299, overseas: 63.99 }
  const selected = /MP16/i.test(crop.productCategory) ? mp16 : cp002
  selected.retail = crop.suggestedRetailPrice ?? selected.retail
  selected.overseas = crop.overseasRetailPrice ?? selected.overseas
  return crop.wirelessVariantPrices ?? { cp002, mp16 }
}

export function productBusinessSpecification(category: string): ProductBusinessSpecification {
  const normalized = normalizeProductCategory(category)
  // Use business keywords instead of full product-name equality so future
  // product types inherit the same class. Specific classes take precedence:
  // “磁吸支架背盖” is a stand, not a magnetic back cover.
  if (normalized.includes(normalizeProductCategory('支架'))) {
    const airbag = normalized.includes(normalizeProductCategory('气囊支架'))
      || normalized.includes(normalizeProductCategory('流沙'))
    return {
      section: 'stand',
      itemClass: '支架',
      suggestedRetailPrice: airbag ? 59 : 49,
      overseasRetailPrice: airbag ? 12.99 : 9.99,
      expandsByModel: false
    }
  }
  if (normalized.includes(normalizeProductCategory('自带线'))
    && (normalized.includes(normalizeProductCategory('充电宝')) || normalized.includes(normalizeProductCategory('移动电源')))) {
    return { section: 'power', itemClass: '自带线', suggestedRetailPrice: 169, overseasRetailPrice: 36.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('磁吸充电宝')) || normalized === normalizeProductCategory('CP002') || normalized === normalizeProductCategory('MP16')) {
    if (normalized.includes(normalizeProductCategory('MP16'))) {
      return { section: 'power', itemClass: '无线充', suggestedRetailPrice: 299, overseasRetailPrice: 63.99, expandsByModel: false, materialNameSuffix: '（10000mAh）' }
    }
    if (normalized.includes(normalizeProductCategory('CP002'))) {
      return { section: 'power', itemClass: '无线充', suggestedRetailPrice: 239, overseasRetailPrice: 51.99, expandsByModel: false }
    }
    return { section: 'power', itemClass: '无线充', suggestedRetailPrice: null, overseasRetailPrice: null, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('磁吸背盖')) || normalized.includes(normalizeProductCategory('单个片材'))) {
    return { section: 'case', itemClass: '单个片材', suggestedRetailPrice: 89, overseasRetailPrice: 19.99, expandsByModel: true }
  }
  if (normalized.includes(normalizeProductCategory('出镜壳'))) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: 129, overseasRetailPrice: 28.99, expandsByModel: true }
  }
  if (normalized.includes(normalizeProductCategory('出片壳'))) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: 149, overseasRetailPrice: 31.99, expandsByModel: true }
  }
  if (normalized.includes(normalizeProductCategory('出彩壳'))) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: 199, overseasRetailPrice: 42.99, expandsByModel: true }
  }
  if (normalized.includes(normalizeProductCategory('奇趣壳'))) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: 99, overseasRetailPrice: 20.99, expandsByModel: true }
  }
  if (normalized.includes(normalizeProductCategory('Macbook保护壳')) || normalized === normalizeProductCategory('Macbook')) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: 169, overseasRetailPrice: 36.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('iPad保护壳'))) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: null, overseasRetailPrice: null, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('礼盒'))) {
    return { section: 'gift', itemClass: '礼盒套装', suggestedRetailPrice: 149, overseasRetailPrice: 31.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('挂绳'))) {
    return { section: 'lanyard', itemClass: '挂绳', suggestedRetailPrice: 69, overseasRetailPrice: 14.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('卡包'))) {
    return { section: 'accessory', itemClass: '卡包', suggestedRetailPrice: 99, overseasRetailPrice: 20.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('镜头膜')) || normalized.includes(normalizeProductCategory('镜头框'))) {
    const flowingSand = normalized.includes(normalizeProductCategory('流沙'))
    return {
      section: 'accessory', itemClass: '配件',
      suggestedRetailPrice: flowingSand ? 89 : 69,
      overseasRetailPrice: flowingSand ? 19.99 : 14.99,
      expandsByModel: false
    }
  }
  if (normalized.includes(normalizeProductCategory('盲盒'))) {
    return { section: 'blind-box', itemClass: '盲盒', suggestedRetailPrice: 39, overseasRetailPrice: 8.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('挂件'))) {
    return { section: 'accessory', itemClass: '挂件', suggestedRetailPrice: 49, overseasRetailPrice: 9.99, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('配件'))) {
    return { section: 'accessory', itemClass: '配件', suggestedRetailPrice: null, overseasRetailPrice: null, expandsByModel: false }
  }
  if (normalized.includes(normalizeProductCategory('壳'))) {
    return { section: 'case', itemClass: '一体壳', suggestedRetailPrice: null, overseasRetailPrice: null, expandsByModel: false }
  }
  return {
    section: `other-${normalized}`,
    itemClass: category || '其他',
    suggestedRetailPrice: null,
    overseasRetailPrice: null,
    expandsByModel: false
  }
}

function pricePreset(suggestedRetailPrice: number, overseasRetailPrice: number, usage: string): BarcodePricePreset {
  return {
    suggestedRetailPrice,
    overseasRetailPrice,
    label: `￥${suggestedRetailPrice.toFixed(2)} / US$${overseasRetailPrice.toFixed(2)} · ${usage}`
  }
}

export function normalizeProductCategory(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s/\\#（）()_-]+/g, '')
}
