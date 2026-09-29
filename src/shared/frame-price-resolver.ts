import type { BarcodeModelSetting, BarcodePricePair, TaskDraftInput } from './contracts'
import { referenceFrameFallbackPrice, referenceFramePrice } from './frame-product-reference'
import { productModelType } from './product-model-settings'

export interface ResolvedFramePrice {
  domestic: number
  overseas: number
}

/** Reference prices are inherited, never stored as manual overrides on a model. */
export function resolveFrameModelPrice(input: {
  category: string
  model: Pick<BarcodeModelSetting, 'name' | 'brand' | 'pricesByCategory'> | null
  frame: 'normal' | 'silver'
  rules?: TaskDraftInput['framePriceRules']
}): ResolvedFramePrice {
  const { category, model, frame, rules } = input
  const type = productModelType(category)
  const exactCategoryRule = rules?.[category]
  const canonicalCategoryRule = type ? rules?.[type] : undefined
  const exactModelRule = model?.pricesByCategory?.[category]?.[frame]
  const canonicalModelRule = type ? model?.pricesByCategory?.[type]?.[frame] : undefined
  const exactBrandRule = model ? exactCategoryRule?.brands?.[model.brand]?.[frame] : undefined
  const canonicalBrandRule = model ? canonicalCategoryRule?.brands?.[model.brand]?.[frame] : undefined
  const reference = model ? referenceFramePrice(category, model.name, frame) : undefined
  const fallback = referenceFrameFallbackPrice(category, frame)
  return {
    domestic: firstPrice(fallback.domestic,
      sameLayerPrice(exactModelRule, canonicalModelRule, 'domestic'),
      sameLayerPrice(exactBrandRule, canonicalBrandRule, 'domestic'),
      sameLayerPrice(exactCategoryRule?.[frame], canonicalCategoryRule?.[frame], 'domestic'),
      reference?.domestic),
    overseas: firstPrice(fallback.overseas,
      sameLayerPrice(exactModelRule, canonicalModelRule, 'overseas'),
      sameLayerPrice(exactBrandRule, canonicalBrandRule, 'overseas'),
      sameLayerPrice(exactCategoryRule?.[frame], canonicalCategoryRule?.[frame], 'overseas'),
      reference?.overseas)
  }
}

/** Undefined aliases inherit their canonical field; null explicitly clears this manual layer. */
function sameLayerPrice(exact: BarcodePricePair | undefined, canonical: BarcodePricePair | undefined, field: keyof BarcodePricePair): number | null | undefined {
  return exact?.[field] === undefined ? canonical?.[field] : exact[field]
}

function firstPrice(fallback: number, ...values: Array<number | null | undefined>): number {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? fallback
}
