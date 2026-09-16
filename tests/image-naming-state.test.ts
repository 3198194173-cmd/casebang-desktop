import { describe, expect, it } from 'vitest'
import type { CropBox, SuggestedCropNames } from '../src/shared/image-contracts'
import {
  applyBatchNameSuggestions,
  mergeForbiddenEnglishNames,
  normalizeEnglishNameKey
} from '../src/shared/image-naming-state'

function crop(id: string, productCategory: string, patternGroupId: string | null = null): CropBox {
  return {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    role: 'product-pattern',
    label: id,
    productCategory,
    suggestedRetailPrice: 89,
    overseasRetailPrice: 19.99,
    material: '',
    patternGroupId,
    confidence: 1,
    categoryConfidence: 1,
    categoryReasons: [],
    patternNameEn: 'Old Name',
    patternNameZh: '旧名称',
    nameCandidates: []
  }
}

function suggestion(cropId: string, englishName: string, chineseName: string): SuggestedCropNames {
  return {
    cropId,
    candidates: [{ englishName, chineseName, reason: '测试批量命名', confidence: 0.9 }]
  }
}

function duplicateNamingUnitCount(crops: CropBox[]): number {
  const unitsByName = new Map<string, Set<string>>()
  for (const item of crops) {
    const nameKey = normalizeEnglishNameKey(item.patternNameEn)
    if (!nameKey) continue
    const units = unitsByName.get(nameKey) ?? new Set<string>()
    units.add(item.patternGroupId ?? item.id)
    unitsByName.set(nameKey, units)
  }
  return [...unitsByName.values()]
    .filter((units) => units.size > 1)
    .reduce((count, units) => count + units.size, 0)
}

describe('batch image naming state', () => {
  it('groups equal AI names across different product categories and synchronizes the name', () => {
    const crops = [crop('case', '磁吸背盖'), crop('power', 'CP006自带线移动电源')]
    const result = applyBatchNameSuggestions(crops, crops, [
      suggestion('case', 'Summer Ocean', '夏日海洋'),
      suggestion('power', 'summer-ocean', '海洋夏日')
    ])

    expect(result[0]?.patternGroupId).toMatch(/^auto-name-/)
    expect(result[1]?.patternGroupId).toBe(result[0]?.patternGroupId)
    expect(result.map((item) => item.patternNameEn)).toEqual(['Summer Ocean', 'Summer Ocean'])
    expect(result.map((item) => item.patternNameZh)).toEqual(['夏日海洋', '夏日海洋'])
    expect(result.map((item) => item.productCategory)).toEqual(['磁吸背盖', 'CP006自带线移动电源'])
    expect(duplicateNamingUnitCount(crops)).toBe(2)
    expect(duplicateNamingUnitCount(result)).toBe(0)
  })

  it('does not auto-group equal names from the same product category', () => {
    const crops = [crop('case-1', '磁吸背盖'), crop('case-2', '磁吸背盖')]
    const result = applyBatchNameSuggestions(crops, crops, [
      suggestion('case-1', 'Summer Ocean', '夏日海洋'),
      suggestion('case-2', 'Summer Ocean', '夏日海洋')
    ])

    expect(result.map((item) => item.patternGroupId)).toEqual([null, null])
    expect(result.map((item) => item.patternNameEn)).toEqual(['Summer Ocean', 'Summer Ocean'])
    expect(duplicateNamingUnitCount(result)).toBe(2)
  })

  it('merges an existing naming unit with a different-category target and updates every member', () => {
    const backCover = crop('back-cover', '磁吸支架背盖', 'stand-pair')
    const stand = crop('stand', '磁吸气囊支架', 'stand-pair')
    const power = crop('power', 'MP16磁吸充电宝')
    const crops = [backCover, stand, power]
    const targets = [backCover, power]
    const result = applyBatchNameSuggestions(crops, targets, [
      suggestion('back-cover', 'Blue Jellyfish', '蓝色水母'),
      suggestion('power', 'Blue Jellyfish', '蓝水母')
    ])

    expect(result.map((item) => item.patternGroupId)).toEqual(['stand-pair', 'stand-pair', 'stand-pair'])
    expect(result.map((item) => item.patternNameEn)).toEqual(['Blue Jellyfish', 'Blue Jellyfish', 'Blue Jellyfish'])
    expect(result.map((item) => item.patternNameZh)).toEqual(['蓝色水母', '蓝色水母', '蓝色水母'])
  })

  it('never puts two same-category targets into one generated group', () => {
    const crops = [
      crop('case-1', '磁吸背盖'),
      crop('case-2', '磁吸背盖'),
      crop('power-1', 'CP006自带线移动电源'),
      crop('power-2', 'CP006自带线移动电源')
    ]
    const result = applyBatchNameSuggestions(crops, crops, crops.map((item) => (
      suggestion(item.id, 'Ocean Stars', '海洋星光')
    )))

    expect(result[0]?.patternGroupId).toBe(result[2]?.patternGroupId)
    expect(result[1]?.patternGroupId).toBe(result[3]?.patternGroupId)
    expect(result[0]?.patternGroupId).not.toBe(result[1]?.patternGroupId)
  })

  it('merges historical and current forbidden names by normalized English name', () => {
    expect(mergeForbiddenEnglishNames(
      ['Photo Wall', ' Summer  Ocean '],
      ['photo-wall', 'Blue Jellyfish', '']
    )).toEqual(['Photo Wall', 'Summer Ocean', 'Blue Jellyfish'])
  })
})
