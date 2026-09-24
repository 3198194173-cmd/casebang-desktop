import { describe, expect, it } from 'vitest'
import { taskDraftBasicsInputSchema, taskDraftInputSchema } from '../src/shared/schemas'

const basics = {
  seriesNameZh: '杭州',
  seriesNameEn: 'Hangzhou',
  ipRemark: '',
  masterImagePath: 'C:\\images\\overview.png'
}

describe('task draft validation by workflow step', () => {
  it('accepts step 1 data without product categories, models or prices', () => {
    expect(taskDraftBasicsInputSchema.parse(basics)).toEqual(basics)
  })

  it('does not validate later-step fields while creating a step 1 draft', () => {
    const input = { ...basics, framePriceRules: { 出镜壳: { brands: { samsung: undefined } } } }
    expect(taskDraftBasicsInputSchema.parse(input)).toEqual(basics)
  })

  it('allows a later-step price override for just one brand', () => {
    const input = {
      ...basics,
      templateName: '自动按产品类型',
      selectedModels: [],
      modelBrandAssignments: {},
      framePriceRules: {
        出镜壳: {
          brands: {
            samsung: { normal: { domestic: 149, overseas: 31.99 } }
          }
        }
      }
    }
    expect(taskDraftInputSchema.safeParse(input).success).toBe(true)
  })

  it('still rejects invalid prices in configured brands', () => {
    const input = {
      ...basics,
      templateName: '自动按产品类型',
      selectedModels: [],
      modelBrandAssignments: {},
      framePriceRules: {
        出镜壳: { brands: { samsung: { normal: { domestic: -1, overseas: 31.99 } } } }
      }
    }
    expect(taskDraftInputSchema.safeParse(input).success).toBe(false)
  })
})
