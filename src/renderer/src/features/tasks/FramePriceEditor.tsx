import type { BarcodeModelSetting, CategoryFramePriceRule, FramePricePair } from '@shared/contracts'
import type { PhoneModelBrand } from '@shared/product-business-rules'
import { referenceFrameFallbackPrice, referenceFrameModels } from '@shared/frame-product-reference'
import { resolveFrameModelPrice } from '@shared/frame-price-resolver'
import { productModelType } from '@shared/product-model-settings'

export const MODEL_BRANDS: Array<{ id: PhoneModelBrand; label: string }> = [
  { id: 'apple', label: '苹果' }, { id: 'samsung', label: '三星' },
  { id: 'huawei', label: '华为' }, { id: 'other', label: '其他' }
]

function mergeManualPairs(exact: FramePricePair | undefined, canonical: FramePricePair | undefined): FramePricePair {
  return Object.fromEntries((['normal', 'silver'] as const).flatMap(frame => {
    const primary = exact?.[frame]
    const inherited = canonical?.[frame]
    if (!primary && !inherited) return []
    return [[frame, {
      domestic: primary?.domestic === undefined ? inherited?.domestic ?? null : primary.domestic,
      overseas: primary?.overseas === undefined ? inherited?.overseas ?? null : primary.overseas
    }]]
  }))
}

/** Mirror the resolver: absent alias fields inherit, explicit null clears this manual layer. */
function categoryRule(rules: Record<string, CategoryFramePriceRule> | undefined, category: string): CategoryFramePriceRule | undefined {
  const exact = rules?.[category]
  const canonical = rules?.[productModelType(category) ?? '']
  if (!exact) return canonical
  if (!canonical || exact === canonical) return exact
  return {
    ...mergeManualPairs(exact, canonical),
    ...(exact.brands || canonical.brands ? { brands: Object.fromEntries(MODEL_BRANDS.flatMap(({ id }) => exact.brands?.[id] || canonical.brands?.[id]
      ? [[id, mergeManualPairs(exact.brands?.[id], canonical.brands?.[id])]] : [])) } : {})
  }
}

function priceLabel(price: { domestic: number; overseas: number }): string {
  return `¥${price.domestic} / US$${price.overseas.toFixed(2)}`
}

export function ModelPriceOverrides({ model, categories, rules, onChange }: {
  model: BarcodeModelSetting
  categories: string[]
  rules: Record<string, CategoryFramePriceRule>
  onChange(model: BarcodeModelSetting): void
}): React.JSX.Element {
  const update = (category: string, frame: 'normal' | 'silver', field: 'domestic' | 'overseas', raw: string): void => {
    const numeric = raw.trim() ? Number(raw) : null
    const categoriesMap = model.pricesByCategory ?? {}
    const current = categoryRule(categoriesMap, category) ?? {}
    const price = current[frame] ?? { domestic: null, overseas: null }
    onChange({
      ...model,
      pricesByCategory: {
        ...categoriesMap,
        [category]: { ...current, [frame]: { ...price, [field]: Number.isFinite(numeric) ? numeric : null } }
      }
    })
  }
  const firstCategory = categories[0] ?? ''
  const normal = resolveFrameModelPrice({ category: firstCategory, model, frame: 'normal', rules })
  const silver = resolveFrameModelPrice({ category: firstCategory, model, frame: 'silver', rules })
  return <details className="model-price-overrides">
    <summary><span>单独设置此机型价格（可选）</span><small className="model-effective-price">生效价：黑框 {priceLabel(normal)}{model.silverEnabled && `；银框 ${priceLabel(silver)}`}</small></summary>
    {categories.map((category) => <div className="model-price-category" key={category}>
      <strong>{category}</strong>
      {(model.silverEnabled ? ['normal', 'silver'] as const : ['normal'] as const).map((frame) => {
        const value = categoryRule(model.pricesByCategory, category)?.[frame]
        const inherited = resolveFrameModelPrice({ category, model: { ...model, pricesByCategory: undefined }, frame, rules })
        return <div key={frame}><span>{frame === 'normal' ? '黑框款（无尾缀）' : '银框款'}</span>
          <label><span>建议零售价（元）</span><input type="number" min="0.01" step="0.01" value={value?.domestic ?? ''} placeholder={`继承 ${inherited.domestic}`} onChange={(event) => update(category, frame, 'domestic', event.target.value)} /></label>
          <label><span>海外零售价（美元）</span><input type="number" min="0.01" step="0.01" value={value?.overseas ?? ''} placeholder={`继承 ${inherited.overseas.toFixed(2)}`} onChange={(event) => update(category, frame, 'overseas', event.target.value)} /></label>
        </div>
      })}
    </div>)}
  </details>
}

export function FramePriceEditor({ categories, rules, onChange }: {
  categories: string[]
  rules: Record<string, CategoryFramePriceRule>
  onChange(rules: Record<string, CategoryFramePriceRule>): void
}): React.JSX.Element {
  const pair = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver'): FramePricePair['normal'] => {
    const current = categoryRule(rules, category)
    return (brand ? current?.brands?.[brand]?.[frame] : current?.[frame]) ?? { domestic: null, overseas: null }
  }
  const update = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver', field: 'domestic' | 'overseas', raw: string): void => {
    const value = raw.trim() ? Number(raw) : null
    const current = categoryRule(rules, category) ?? {}
    if (brand) {
      const brands = current.brands ?? {}
      const brandRule = brands[brand] ?? {}
      onChange({ ...rules, [category]: { ...current, brands: { ...brands, [brand]: { ...brandRule, [frame]: { ...pair(category, brand, frame), [field]: Number.isFinite(value) ? value : null } } } } })
    } else {
      onChange({ ...rules, [category]: { ...current, [frame]: { ...pair(category, null, frame), [field]: Number.isFinite(value) ? value : null } } })
    }
  }
  const inheritedHint = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver', field: 'domestic' | 'overseas'): string => {
    const categoryValue = pair(category, null, frame)?.[field]
    if (brand && categoryValue !== null && categoryValue !== undefined) return `继承 ${categoryValue}`
    const references = referenceFrameModels(category)?.filter(model => !brand || model.brand === brand) ?? []
    const values = [...new Set(references.flatMap(model => model[frame] ? [model[frame]![field]] : []))].sort((a, b) => a - b)
    if (!values.length) values.push(referenceFrameFallbackPrice(category, frame)[field])
    return `参考 ${values.join(' / ')}`
  }
  const priceInputs = (category: string, brand: PhoneModelBrand | null, frame: 'normal' | 'silver'): React.JSX.Element => {
    const value = pair(category, brand, frame)
    return <div className="frame-price-pair" role="group" aria-label={`${category} / ${brand ? MODEL_BRANDS.find((item) => item.id === brand)?.label : '类别默认'} / ${frame === 'normal' ? '黑框款' : '银框款'}`}>
      <label><span>建议零售价（元）</span><input type="number" min="0.01" step="0.01" value={value?.domestic ?? ''} placeholder={inheritedHint(category, brand, frame, 'domestic')} onChange={(event) => update(category, brand, frame, 'domestic', event.target.value)} /></label>
      <label><span>海外零售价（美元）</span><input type="number" min="0.01" step="0.01" value={value?.overseas ?? ''} placeholder={inheritedHint(category, brand, frame, 'overseas')} onChange={(event) => update(category, brand, frame, 'overseas', event.target.value)} /></label>
    </div>
  }
  return <section className="frame-price-editor">
    <header><div><strong>黑框 / 银框价格调整</strong><span>生效顺序：单机型 → 品牌 → 类别 → 260928 参考价；国内与海外价格分别继承，留空不覆盖。机型价格随确认保存；下面的品牌 / 类别价格仅用于当前任务。</span></div></header>
    {categories.map((category) => <details key={category} open>
      <summary>{category}</summary>
      <div className="frame-price-table">
        <div className="frame-price-header"><span>适用范围</span><b>黑框款（无尾缀）</b><b>银框款</b></div>
        <div className="frame-price-row"><strong>类别默认</strong>{priceInputs(category, null, 'normal')}{priceInputs(category, null, 'silver')}</div>
        {MODEL_BRANDS.map((brand) => <div className="frame-price-row" key={brand.id}><strong>{brand.label}</strong>{priceInputs(category, brand.id, 'normal')}{priceInputs(category, brand.id, 'silver')}</div>)}
      </div>
    </details>)}
  </section>
}
