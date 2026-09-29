import type { BarcodeModelSetting } from './contracts'
import { referenceFrameModels } from './frame-product-reference'
import { normalizeProductCategory, phoneModelBrand, REFERENCE_PHONE_MODELS, sortBarcodeModelsByReference } from './product-business-rules'

export const PRODUCT_MODEL_TYPES = ['磁吸背盖', '出镜壳', '出片壳', '出彩壳', '奇趣壳', 'MacBook', 'iPad', '镜头膜'] as const

export type ProductModelType = typeof PRODUCT_MODEL_TYPES[number]
/** An absent type means use defaults (or migrate a legacy phone-model selection); [] explicitly disables it. */
export type ProductModelSettings = Partial<Record<ProductModelType, BarcodeModelSetting[]>>

export const REFERENCE_MACBOOK_MODELS = [
  'Macbook Air 13（2018-2020）', 'MacbookPro 13（2018-2020）', 'Macbook Air 13.6（2022-2024）',
  'Macbook Pro 14（2021-2023）', 'Macbook Air 15（2023-2025）', 'Macbook Pro 16（2021-2023）'
] as const

export const REFERENCE_IPAD_MODELS = [
  'iPad Mini 8.3英寸（2024-2025）', 'iPad Pro 12.9英寸（2022）', 'iPad Air 10.9/11英寸（2024-2025）',
  'iPad Pro 11英寸（2024）', 'iPad Pro 13英寸（2024）', 'iPad Air 13英寸（2024-2025）'
] as const

export const REFERENCE_LENS_MODELS = ['iP18 Pro/17 Pro', 'iP18 Pro Max/17 Pro Max'] as const

/** Classify business category aliases, not a substring such as every product containing 背盖. */
export function productModelType(category: string): ProductModelType | null {
  const value = normalizeProductCategory(category)
  if (value.includes('支架')) return null
  if (value.includes('磁吸背盖') || value === '单个片材') return '磁吸背盖'
  if (value.includes('出镜壳')) return '出镜壳'
  if (value.includes('出片壳') || value === '出片材') return '出片壳'
  if (value.includes('出彩壳')) return '出彩壳'
  if (value.includes('奇趣壳')) return '奇趣壳'
  if (value.includes('macbook')) return 'MacBook'
  if (value.includes('ipad') || value === 'pad' || value.includes('pad保护壳')) return 'iPad'
  if (value.includes('镜头膜') || value.includes('镜头框')) return '镜头膜'
  return null
}

export function supportsSilverFrame(category: string): boolean {
  const type = productModelType(category)
  return type === '出镜壳' || type === '出片壳'
}

/** Every type owns distinct records, even when its starting phone list is the same. */
export function createDefaultProductModelSettings(): Record<ProductModelType, BarcodeModelSetting[]> {
  return Object.fromEntries(PRODUCT_MODEL_TYPES.map((type) => {
    const frameModels = referenceFrameModels(type)
    if (frameModels) {
      // Workbook prices remain reference fallbacks, not user overrides; copying
      // them into pricesByCategory would prevent brand/category edits taking effect.
      return [type, sortBarcodeModelsByReference(frameModels.map((model, index) => ({
        id: `product-model-${PRODUCT_MODEL_TYPES.indexOf(type)}-${index}`,
        name: model.name,
        brand: model.brand,
        enabled: true,
        silverEnabled: model.silver !== undefined
      })))]
    }
    const names = type === 'MacBook' ? REFERENCE_MACBOOK_MODELS
      : type === 'iPad' ? REFERENCE_IPAD_MODELS
        : type === '镜头膜' ? REFERENCE_LENS_MODELS : REFERENCE_PHONE_MODELS
    return [type, names.map((name, index) => ({
      id: `product-model-${PRODUCT_MODEL_TYPES.indexOf(type)}-${index}`,
      name,
      brand: type === 'MacBook' || type === 'iPad' ? 'apple' : phoneModelBrand(name),
      enabled: true,
      silverEnabled: false
    }))]
  })) as Record<ProductModelType, BarcodeModelSetting[]>
}

export function normalizeProductModels(productType: ProductModelType, models: readonly BarcodeModelSetting[]): BarcodeModelSetting[] {
  return models.map((model) => {
    const copy = structuredClone(model)
    if (!supportsSilverFrame(productType)) {
      copy.silverEnabled = false
      if (copy.pricesByCategory) {
        copy.pricesByCategory = Object.fromEntries(Object.entries(copy.pricesByCategory).map(([category, pair]) => [category, { normal: pair.normal }]))
      }
    }
    return copy
  })
}

export function normalizeProductModelSettings(settings: ProductModelSettings): ProductModelSettings {
  return Object.fromEntries(PRODUCT_MODEL_TYPES.flatMap((type) => settings[type] === undefined ? [] : [[type, normalizeProductModels(type, settings[type])]]))
}
