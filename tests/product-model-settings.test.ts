import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: {} }))
import { SettingsRepository } from '../src/main/infrastructure/settings-repository'
import {
  createDefaultProductModelSettings, normalizeProductModelSettings, PRODUCT_MODEL_TYPES, productModelType,
  REFERENCE_IPAD_MODELS, REFERENCE_LENS_MODELS, REFERENCE_MACBOOK_MODELS, supportsSilverFrame
} from '../src/shared/product-model-settings'
import { productBusinessSpecification } from '../src/shared/product-business-rules'
import { productModelSettingsSchema, saveProductModelSettingsInputSchema, taskDraftInputSchema } from '../src/shared/schemas'

describe('product-type model defaults and aliases', () => {
  it('creates independent 38-model non-frame phone lists and the requested special model lists', () => {
    const defaults = createDefaultProductModelSettings()
    expect(Object.keys(defaults)).toEqual([...PRODUCT_MODEL_TYPES])
    for (const type of ['磁吸背盖', '出彩壳', '奇趣壳'] as const) {
      expect(defaults[type]).toHaveLength(38)
      expect(defaults[type].every((model) => model.enabled)).toBe(true)
      expect(defaults[type].filter((model) => model.brand === 'apple')).toHaveLength(17)
      expect(defaults[type].filter((model) => model.brand === 'samsung')).toHaveLength(8)
      expect(defaults[type].filter((model) => model.brand === 'huawei')).toHaveLength(13)
    }
    expect(defaults.MacBook.map((model) => model.name)).toEqual([...REFERENCE_MACBOOK_MODELS])
    expect(defaults.iPad.map((model) => model.name)).toEqual([...REFERENCE_IPAD_MODELS])
    expect(defaults['镜头膜'].map((model) => model.name)).toEqual([...REFERENCE_LENS_MODELS])
    defaults['出镜壳'][0]!.name = 'Modified model'
    expect(defaults['磁吸背盖'][0]?.name).toBe('iP13 Pro')
    expect(createDefaultProductModelSettings()['出镜壳'][0]?.name).toBe('iP13 Pro')
  })

  it('uses the workbook-specific frame catalogues without storing reference prices as user overrides', () => {
    const defaults = createDefaultProductModelSettings()
    expect(defaults['出镜壳']).toHaveLength(51)
    expect(defaults['出片壳']).toHaveLength(17)
    for (const type of ['出镜壳', '出片壳'] as const) {
      expect(defaults[type].filter((model) => model.silverEnabled)).toHaveLength(10)
      expect(defaults[type].every((model) => model.enabled && model.pricesByCategory === undefined)).toBe(true)
    }
    expect(defaults['出镜壳'].filter((model) => model.brand === 'apple')).toHaveLength(17)
    expect(defaults['出镜壳'].filter((model) => model.brand === 'samsung')).toHaveLength(4)
    expect(defaults['出镜壳'].filter((model) => model.brand === 'huawei')).toHaveLength(7)
    expect(defaults['出镜壳'].filter((model) => model.brand === 'other')).toHaveLength(23)
    expect([...new Set(defaults['出镜壳'].map((model) => model.brand))]).toEqual(['apple', 'samsung', 'huawei', 'other'])
    defaults['出镜壳'][0]!.silverEnabled = true
    expect(defaults['出片壳'][0]?.silverEnabled).toBe(false)
    expect(createDefaultProductModelSettings()['出镜壳'][0]?.silverEnabled).toBe(false)
  })

  it.each([
    ['Macbook保护壳', 'MacBook'], ['MAC BOOK', 'MacBook'], ['iPad保护壳', 'iPad'], ['Pad保护壳', 'iPad'],
    ['Pad', 'iPad'], ['出片材', '出片壳'], ['新款磁吸背盖', '磁吸背盖'], ['流沙镜头膜', '镜头膜'],
    ['镜头框', '镜头膜'], ['磁吸支架背盖', null], ['CP002磁吸充电宝', null], ['其他', null]
  ])('maps %s to its independent product profile', (category, expected) => {
    expect(productModelType(category!)).toBe(expected)
  })

  it('allows silver frames only for 出镜壳/出片壳 and expands all eight types by model', () => {
    for (const type of PRODUCT_MODEL_TYPES) {
      expect(supportsSilverFrame(type)).toBe(type === '出镜壳' || type === '出片壳')
      expect(productBusinessSpecification(type).expandsByModel).toBe(true)
      const models = createDefaultProductModelSettings()[type]
      expect(models.filter((model) => model.silverEnabled)).toHaveLength(supportsSilverFrame(type) ? 10 : 0)
    }
    expect(supportsSilverFrame('出片材')).toBe(true)
    expect(productBusinessSpecification('Pad保护壳').expandsByModel).toBe(true)
    expect(productBusinessSpecification('磁吸支架背盖').expandsByModel).toBe(false)
  })

  it('normalizes accidental silver flags/prices on non-frame product types without mutating input', () => {
    const model = createDefaultProductModelSettings()['出镜壳'].find((entry) => entry.name === 'iP14 Pro')!
    model.pricesByCategory = { 磁吸背盖: { normal: { domestic: 89, overseas: 19.99 }, silver: { domestic: 169, overseas: 36.99 } } }
    const result = normalizeProductModelSettings({ 磁吸背盖: [model], 出镜壳: [model] })
    expect(result['磁吸背盖']?.[0]?.silverEnabled).toBe(false)
    expect(result['磁吸背盖']?.[0]?.pricesByCategory?.['磁吸背盖']?.silver).toBeUndefined()
    expect(result['出镜壳']?.[0]?.silverEnabled).toBe(true)
    expect(model.silverEnabled).toBe(true)
  })
})

describe('product-type model validation', () => {
  it('accepts absent or intentionally empty product selections while preserving legacy drafts', () => {
    expect(productModelSettingsSchema.parse({})).toEqual({})
    expect(saveProductModelSettingsInputSchema.parse({ productType: 'iPad', models: [] })).toEqual({ productType: 'iPad', models: [] })
    const legacy = {
      templateName: '自动按产品类型', seriesNameZh: '测试', seriesNameEn: 'Test Series', ipRemark: '',
      selectedModels: ['iP13 Pro'], modelBrandAssignments: { 'iP13 Pro': 'apple' }, masterImagePath: 'C:/images/overview.png'
    }
    expect(taskDraftInputSchema.safeParse(legacy).success).toBe(true)
    expect(taskDraftInputSchema.parse({ ...legacy, productModelSettings: { 磁吸背盖: [] }, productModelsConfirmed: ['磁吸背盖'] }).productModelSettings).toEqual({ 磁吸背盖: [] })
  })

  it('rejects duplicate ids and duplicate enabled names but permits a disabled duplicate name', () => {
    const model = createDefaultProductModelSettings().iPad[0]!
    const input = { productType: 'iPad', models: [model, { ...model, id: 'second', name: model.name.toUpperCase() }] }
    expect(saveProductModelSettingsInputSchema.safeParse(input).success).toBe(false)
    expect(saveProductModelSettingsInputSchema.safeParse({ ...input, models: [model, { ...model, enabled: false }] }).success).toBe(false)
    expect(saveProductModelSettingsInputSchema.safeParse({ ...input, models: [model, { ...model, id: 'second', enabled: false }] }).success).toBe(true)
    expect(productModelSettingsSchema.safeParse({ 未知壳体: [] }).success).toBe(false)
  })
})

describe('remembered product model selection persistence', () => {
  it('reads freshly confirmed models when switching series immediately without awaiting the save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-product-model-read-after-save-'))
    try {
      const repository = new SettingsRepository(join(directory, 'settings.json'))
      const defaults = createDefaultProductModelSettings()
      const firstSave = repository.setProductModelSettings({ productType: '出镜壳', models: defaults['出镜壳'].slice(0, 2) })
      const secondSave = repository.setProductModelSettings({ productType: 'iPad', models: defaults.iPad.slice(0, 1) })
      // The next workflow must await both previously queued writes, even if its caller did not.
      const immediateRead = repository.getProductModelSettings()
      expect(await immediateRead).toEqual({ 出镜壳: defaults['出镜壳'].slice(0, 2), iPad: defaults.iPad.slice(0, 1) })
      await Promise.all([firstSave, secondSave])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores each confirmed type after restart without changing other application settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-product-model-settings-'))
    try {
      const filePath = join(directory, 'settings.json')
      const repository = new SettingsRepository(filePath)
      expect(await repository.getProductModelSettings()).toEqual({})
      await repository.setLastMasterImageDirectory('C:/images')
      const camera = createDefaultProductModelSettings()['出镜壳'].slice(0, 2)
      camera[0]!.enabled = false
      camera[1]!.silverEnabled = false
      camera[1]!.name = 'Custom model'
      await repository.setProductModelSettings({ productType: '出镜壳', models: camera })
      await repository.setProductModelSettings({ productType: 'iPad', models: [] })
      const restarted = new SettingsRepository(filePath)
      expect(await restarted.getProductModelSettings()).toEqual({ 出镜壳: camera, iPad: [] })
      expect(await restarted.getLastMasterImageDirectory()).toBe('C:/images')
      expect(JSON.parse(await readFile(filePath, 'utf8')).productModelSettings.iPad).toEqual([])
      const returned = await restarted.getProductModelSettings()
      returned['出镜壳']![1]!.name = 'Changed outside repository'
      expect((await restarted.getProductModelSettings())['出镜壳']?.[1]?.name).toBe('Custom model')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps simultaneous per-type confirmations isolated and remembers deletions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-product-model-concurrent-'))
    try {
      const repository = new SettingsRepository(join(directory, 'settings.json'))
      const defaults = createDefaultProductModelSettings()
      await Promise.all([
        repository.setProductModelSettings({ productType: '磁吸背盖', models: defaults['磁吸背盖'].slice(0, 1) }),
        repository.setProductModelSettings({ productType: '出镜壳', models: defaults['出镜壳'].slice(0, 2) }),
        repository.setProductModelSettings({ productType: '镜头膜', models: defaults['镜头膜'] })
      ])
      const remembered = await repository.getProductModelSettings()
      expect(remembered['磁吸背盖']).toHaveLength(1)
      expect(remembered['出镜壳']).toHaveLength(2)
      expect(remembered['镜头膜']).toHaveLength(2)
      await repository.setProductModelSettings({ productType: '出镜壳', models: [] })
      expect((await repository.getProductModelSettings())['出镜壳']).toEqual([])
      expect((await repository.getProductModelSettings())['磁吸背盖']).toHaveLength(1)
      await expect(repository.setProductModelSettings({ productType: '出镜壳', models: [{ ...defaults['出镜壳'][0]!, name: '' }] })).rejects.toThrow()
      await repository.setProductModelSettings({ productType: 'MacBook', models: defaults.MacBook })
      expect((await repository.getProductModelSettings()).MacBook).toHaveLength(6)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
