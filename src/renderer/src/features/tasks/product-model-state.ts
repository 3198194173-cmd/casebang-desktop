import type { BarcodeModelSetting, TaskDraftInput } from '@shared/contracts'
import { phoneModelBrand, sortBarcodeModelsByReference } from '@shared/product-business-rules'
import {
  PRODUCT_MODEL_TYPES, createDefaultProductModelSettings, productModelType, supportsSilverFrame,
  type ProductModelSettings, type ProductModelType
} from '@shared/product-model-settings'

export function initializeProductModelState(form: TaskDraftInput, remembered: ProductModelSettings): {
  settings: ProductModelSettings; confirmed: ProductModelType[]
} {
  const defaults = createDefaultProductModelSettings()
  const legacy = form.modelSettings?.length ? form.modelSettings : form.selectedModels.map((name, index) => ({
    id: `legacy-${index}`, name, brand: form.modelBrandAssignments[name] ?? phoneModelBrand(name), enabled: true, silverEnabled: true
  }))
  const settings: ProductModelSettings = {}
  for (const productType of PRODUCT_MODEL_TYPES) {
    const previous = form.productModelSettings?.[productType] ?? remembered[productType]
    // An intentionally empty profile stays empty. Old phone selections never become tablet/laptop models.
    const usesLegacyPhones = PRODUCT_MODEL_TYPES.indexOf(productType) < 5 && !supportsSilverFrame(productType)
    const models = previous ?? (usesLegacyPhones && legacy.length ? legacy : defaults[productType]) ?? []
    settings[productType] = structuredClone(models).map(model => ({ ...model, silverEnabled: supportsSilverFrame(productType) && model.silverEnabled }))
  }
  const confirmed = PRODUCT_MODEL_TYPES.filter(type => form.productModelSettings?.[type] !== undefined
    ? form.productModelsConfirmed?.includes(type)
    : remembered[type] !== undefined)
  return { settings, confirmed }
}

/** Explicitly apply the new reference to this draft only; confirmed memory is saved separately. */
export function applyFrameReferenceToDraft(form: TaskDraftInput, productType: ProductModelType): TaskDraftInput {
  if (!supportsSilverFrame(productType)) throw new Error('只有出镜壳和出片壳可以套用框型参考配置。')
  return {
    ...form,
    productModelSettings: { ...form.productModelSettings, [productType]: createDefaultProductModelSettings()[productType] },
    productModelsConfirmed: form.productModelsConfirmed?.filter(type => type !== productType) ?? [],
    framePriceRules: Object.fromEntries(Object.entries(form.framePriceRules ?? {}).filter(([category]) => productModelType(category) !== productType))
  }
}

export function productModelIssues(models: readonly BarcodeModelSetting[], requiresSelection: boolean): string[] {
  const issues: string[] = []
  const names = models.map(model => model.name.trim().normalize('NFKC').toLocaleLowerCase())
  if (names.some(name => !name)) issues.push('机型名称不能为空。')
  if (new Set(names).size !== names.length) issues.push('机型名称不能重复。')
  if (requiresSelection && !models.some(model => model.enabled)) issues.push('本次有该类型产品，请至少启用一个机型。')
  return issues
}

export function normalizeProductModels(productType: ProductModelType, models: readonly BarcodeModelSetting[]): BarcodeModelSetting[] {
  return sortBarcodeModelsByReference(models.map(model => ({ ...model, name: model.name.trim(), silverEnabled: supportsSilverFrame(productType) && model.silverEnabled })))
}

export function allProductModelsConfirmed(required: readonly ProductModelType[], confirmed: readonly ProductModelType[], settings: ProductModelSettings): boolean {
  return required.every(type => confirmed.includes(type) && productModelIssues(settings[type] ?? [], true).length === 0)
}
