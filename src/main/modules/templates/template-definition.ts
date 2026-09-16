export interface TemplateFieldMapping {
  seriesName: string
  seriesNameUppercase: string
  seriesCode: string
  productCode: string
  patternName: string
  patternNameUppercase: string
  imageAnchor: string
}

export interface ProductSlotRule {
  productCategory: string
  codePrefix: string | null
  imageOrder: number
  sharedNumberPool?: string
  allowEmptySlot: boolean
}

export interface TemplateDefinition {
  id: string
  displayName: string
  sourceSheetNames: string[]
  copyRange: string
  fieldMapping: TemplateFieldMapping
  productSlots: ProductSlotRule[]
  preserve: {
    formulas: boolean
    styles: boolean
    rowHeights: boolean
    columnWidths: boolean
    mergedCells: boolean
  }
}

export function validateTemplateDefinition(definition: TemplateDefinition): string[] {
  const errors: string[] = []
  if (!definition.id.trim()) errors.push('模板 ID 不能为空')
  if (!definition.displayName.trim()) errors.push('模板名称不能为空')
  if (definition.sourceSheetNames.length === 0) errors.push('至少指定一个源工作表')
  if (!definition.copyRange.trim()) errors.push('复制范围不能为空')

  const orders = definition.productSlots.map((slot) => slot.imageOrder)
  if (new Set(orders).size !== orders.length) errors.push('产品图片顺序不能重复')

  return errors
}
