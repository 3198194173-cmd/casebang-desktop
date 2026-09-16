import { describe, expect, it } from 'vitest'
import { TemplateRegistry } from '../src/main/modules/templates/template-registry'
import type { TemplateDefinition } from '../src/main/modules/templates/template-definition'

const template: TemplateDefinition = {
  id: 'detachable-other',
  displayName: '可拆卸+其他',
  sourceSheetNames: ['可拆卸+其他'],
  copyRange: 'A1:K500',
  fieldMapping: {
    seriesName: 'D',
    seriesNameUppercase: 'E',
    seriesCode: 'F',
    productCode: 'G',
    patternName: 'H',
    patternNameUppercase: 'I',
    imageAnchor: 'C'
  },
  productSlots: [
    { productCategory: '磁吸背盖', codePrefix: 'BG', imageOrder: 1, allowEmptySlot: false },
    { productCategory: '磁吸支架背盖', codePrefix: 'ZJBG', imageOrder: 2, sharedNumberPool: 'ZJ', allowEmptySlot: true },
    { productCategory: '磁吸气囊支架', codePrefix: 'ZJQN', imageOrder: 3, sharedNumberPool: 'ZJ', allowEmptySlot: true }
  ],
  preserve: {
    formulas: true,
    styles: true,
    rowHeights: true,
    columnWidths: true,
    mergedCells: true
  }
}

describe('template registry', () => {
  it('stores a valid template independently from the caller object', () => {
    const registry = new TemplateRegistry()
    registry.register(template)
    const loaded = registry.get(template.id)
    expect(loaded.displayName).toBe('可拆卸+其他')
    expect(loaded.productSlots).toHaveLength(3)
  })

  it('rejects duplicate template ids', () => {
    const registry = new TemplateRegistry()
    registry.register(template)
    expect(() => registry.register(template)).toThrow('已存在')
  })
})
