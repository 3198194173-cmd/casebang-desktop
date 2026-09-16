import { describe, expect, it, vi } from 'vitest'
import { applyMaterial, fixedMaterial, normalizeMaterial } from '../src/shared/material-recognition'
import type { CropBox, ImageAnalysisResult } from '../src/shared/image-contracts'
vi.mock('../src/main/modules/naming/naming-request-support', () => ({ createCropPreview: vi.fn(async () => Buffer.from('crop')) }))
import { recognizeMaterial } from '../src/main/modules/naming/material-recognition'

const crop = { id: 'a', material: '', productCategory: '出镜壳', x: 0, y: 0, width: 100, height: 100 } as CropBox
const input = { sourceImagePath: 'test.png', crop }
describe('material recognition', () => {
  it('uses fixed stand rules', () => {
    expect(fixedMaterial('磁吸气囊支架')).toBe('透明')
    expect(fixedMaterial('磁吸支架背盖')).toBe('银色')
    expect(fixedMaterial('磁吸背盖支架')).toBe('银色')
    expect(fixedMaterial('磁吸背盖')).toBeNull()
  })
  it('allows only dropdown values and falls back by tendency', () => {
    expect(normalizeMaterial('镜面片材', 'silver', 0.9)).toBe('镜面片材')
    expect(normalizeMaterial('自创材质', 'silver', 0.9)).toBe('银色')
    expect(normalizeMaterial('镜面', 'transparent', 0.3)).toBe('透明')
  })
  it('updates only the actual crop, not its same-pattern peers', () => {
    const current = { sourceImagePath: 'test.png', crops: [crop, { ...crop, id: 'b' }] } as ImageAnalysisResult
    const next = applyMaterial(current, input, { material: '透明', reason: '', confidence: 1 })
    expect(next.crops.map(c => c.material)).toEqual(['透明', ''])
    expect(applyMaterial({ ...current, sourceImagePath: 'other.png' }, input, { material: '透明', reason: '', confidence: 1 }).crops[0]!.material).toBe('')
  })
  it('preserves edits and changed geometry/category', () => {
    for (const change of [{ material: '贝母' }, { x: 10 }, { productCategory: '出片壳' }]) {
      const current = { sourceImagePath: 'test.png', crops: [{ ...crop, ...change }] } as ImageAnalysisResult
      expect(applyMaterial(current, input, { material: '透明', reason: '', confidence: 1 }).crops[0]).toEqual(current.crops[0])
    }
  })
  it('never replaces a value marked as manually edited', () => {
    const manual = { ...crop, material: '镜面片材', materialSource: 'manual' as const }
    const current = { sourceImagePath: 'test.png', crops: [manual] } as ImageAnalysisResult
    const matchingInput = { sourceImagePath: 'test.png', crop: manual }
    expect(applyMaterial(current, matchingInput, { material: '透明', reason: '', confidence: 1 }).crops[0]).toEqual(manual)
  })
  it('sends only the new crop with rules and validates cloud output', async () => {
    const request = vi.fn(async () => JSON.stringify({ material: '镜面', tendency: 'silver', confidence: 0.9, reason: '整体反射渐变' }))
    expect((await recognizeMaterial(input, request)).material).toBe('镜面')
    expect(JSON.stringify(request.mock.calls)).toContain('白色磁吸圈')
    await expect(recognizeMaterial(input, async () => '{}')).rejects.toThrow()
  })
})
