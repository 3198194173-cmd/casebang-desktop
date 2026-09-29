import { describe, expect, it } from 'vitest'
import type { TaskDraftInput } from '../src/shared/contracts'
import { createDefaultProductModelSettings } from '../src/shared/product-model-settings'
import { allProductModelsConfirmed, applyFrameReferenceToDraft, initializeProductModelState, normalizeProductModels, productModelIssues } from '../src/renderer/src/features/tasks/product-model-state'

const form: TaskDraftInput = {
  templateName: '自动按产品类型', seriesNameZh: '', seriesNameEn: 'Test', ipRemark: '',
  selectedModels: ['iP13 Pro'], modelBrandAssignments: {}, masterImagePath: 'test.png'
}

describe('per-product model selection state', () => {
  it('migrates legacy phone selections without turning laptop/tablet/lens models into phones', () => {
    const state = initializeProductModelState(form, {})
    expect(state.settings['磁吸背盖']?.map(model => model.name)).toEqual(['iP13 Pro'])
    expect(state.settings['出镜壳']).toHaveLength(51)
    expect(state.settings['出片壳']).toHaveLength(17)
    expect(state.settings['出镜壳']?.[0]?.silverEnabled).toBe(false)
    expect(state.settings['磁吸背盖']?.[0]?.silverEnabled).toBe(false)
    expect(state.settings.MacBook).toHaveLength(6)
    expect(state.settings.iPad).toHaveLength(6)
    expect(state.settings['镜头膜']).toHaveLength(2)
    expect(state.confirmed).toEqual([])
  })

  it('uses confirmed memory in either upstream workflow and keeps types isolated', () => {
    const defaults = createDefaultProductModelSettings()
    const camera = defaults['出镜壳']!.slice(0, 2)
    camera[0]!.enabled = false
    const remembered = { 出镜壳: camera, iPad: [] }
    const state = initializeProductModelState(form, remembered)
    expect(state.settings['出镜壳']).toEqual(camera)
    expect(state.settings['磁吸背盖']).toHaveLength(1)
    expect(state.settings.iPad).toEqual([])
    expect(state.confirmed).toEqual(['出镜壳', 'iPad'])
    state.settings['出镜壳']![0]!.name = 'changed in current draft'
    expect(camera[0]!.name).not.toBe('changed in current draft')
  })

  it('preserves unconfirmed task edits over saved memory', () => {
    const defaults = createDefaultProductModelSettings()
    const state = initializeProductModelState({ ...form, productModelSettings: { 磁吸背盖: [] }, productModelsConfirmed: [] }, { 磁吸背盖: defaults['磁吸背盖'] })
    expect(state.settings['磁吸背盖']).toEqual([])
    expect(state.confirmed).not.toContain('磁吸背盖')
  })

  it('loads the latest shared memory after the task changes image or series', () => {
    const defaults = createDefaultProductModelSettings()
    const staleDraft = { ...form, productModelSettings: defaults, productModelsConfirmed: ['出镜壳' as const] }
    const remembered = { 出镜壳: defaults['出镜壳']!.slice(0, 3) }
    const nextSeries = { ...staleDraft, productModelSettings: undefined, productModelsConfirmed: undefined }
    const state = initializeProductModelState(nextSeries, remembered)
    expect(state.settings['出镜壳']).toHaveLength(3)
    expect(state.confirmed).toContain('出镜壳')
    expect(staleDraft.productModelSettings['出镜壳']).toHaveLength(51)
  })

  it('requires confirmation and at least one enabled model for every present type only', () => {
    const settings = createDefaultProductModelSettings()
    expect(allProductModelsConfirmed(['磁吸背盖', 'iPad'], ['磁吸背盖'], settings)).toBe(false)
    expect(allProductModelsConfirmed(['磁吸背盖', 'iPad'], ['磁吸背盖', 'iPad'], settings)).toBe(true)
    settings.iPad = []
    expect(allProductModelsConfirmed(['磁吸背盖', 'iPad'], ['磁吸背盖', 'iPad'], settings)).toBe(false)
    expect(allProductModelsConfirmed(['磁吸背盖'], ['磁吸背盖'], settings)).toBe(true)
    expect(allProductModelsConfirmed([], [], settings)).toBe(true)
  })

  it('rejects duplicate/blank names and permits empty selections for absent types', () => {
    const model = createDefaultProductModelSettings()['磁吸背盖']![0]!
    expect(productModelIssues([], false)).toEqual([])
    expect(productModelIssues([], true)).toHaveLength(1)
    expect(productModelIssues([{ ...model, name: ' ' }], false)).toHaveLength(1)
    expect(productModelIssues([model, { ...model, id: 'other', name: ` ${model.name.toUpperCase()} ` }], false)).toHaveLength(1)
  })

  it('normalizes non-frame flags and preserves known phone order', () => {
    const settings = createDefaultProductModelSettings()['出镜壳']!
    const normalized = normalizeProductModels('磁吸背盖', [settings[1]!, { ...settings[0]!, name: ` ${settings[0]!.name} ` }])
    expect(normalized.map(model => model.name)).toEqual([settings[0]!.name, settings[1]!.name])
    expect(normalized.every(model => !model.silverEnabled)).toBe(true)
  })

  it('applies the latest frame reference only on request, clears its overrides, and preserves other type edits', () => {
    const defaults = createDefaultProductModelSettings()
    const camera = defaults['出镜壳']!.slice(0, 2)
    camera[0]!.pricesByCategory = { 出镜壳: { normal: { domestic: 188, overseas: 40 } } }
    const current = { ...form, productModelSettings: { 出镜壳: camera, 出片壳: [] }, productModelsConfirmed: ['出镜壳', '出片壳'] as const,
      framePriceRules: { 出镜壳: { normal: { domestic: 188, overseas: 40 } }, 出片材: { normal: { domestic: 200, overseas: 50 } } } }
    const input: TaskDraftInput = { ...current, productModelsConfirmed: [...current.productModelsConfirmed] }
    const restored = initializeProductModelState(input, {})
    expect(restored.settings['出镜壳']).toHaveLength(2)
    expect(restored.settings['出镜壳']?.[0]?.pricesByCategory?.['出镜壳']?.normal?.domestic).toBe(188)
    const next = applyFrameReferenceToDraft(input, '出镜壳')
    expect(next.productModelSettings?.['出镜壳']).toHaveLength(51)
    expect(next.productModelSettings?.['出镜壳']?.some(model => model.pricesByCategory)).toBe(false)
    expect(next.productModelSettings?.['出片壳']).toEqual([])
    expect(next.productModelsConfirmed).toEqual(['出片壳'])
    expect(next.framePriceRules).toEqual({ 出片材: input.framePriceRules?.['出片材'] })
    expect(input.productModelSettings?.['出镜壳']).toHaveLength(2)
    expect(applyFrameReferenceToDraft(input, '出片壳').framePriceRules).toEqual({ 出镜壳: input.framePriceRules?.['出镜壳'] })
  })
})
