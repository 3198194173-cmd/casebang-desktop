import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsRepository } from '../src/main/infrastructure/settings-repository'
import { AliyunVisionService } from '../src/main/modules/naming/aliyun-vision-service'
import type { CropBox, SuggestImageNamesBatchInput } from '../src/shared/image-contracts'

describe('Aliyun batch naming retry', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retries only the same-category collision and returns two unique names in one operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-naming-'))
    const imagePath = join(directory, 'patterns.png')
    try {
      await sharp({ create: { width: 220, height: 110, channels: 3, background: '#f5f5f5' } }).png().toFile(imagePath)
      const settings = {
        getCloudAiSettings: async () => ({
          provider: 'aliyun' as const,
          model: 'qwen3-vl-flash',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'test-key'
        })
      } as unknown as SettingsRepository
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(aiResponse([
          aiItem('I01', 'Ocean Stars'),
          aiItem('I02', 'Ocean Stars')
        ]))
        .mockResolvedValueOnce(aiResponse([aiItem('I01', 'Fresh Tide')]))

      const input: SuggestImageNamesBatchInput = {
        sourceImagePath: imagePath,
        crops: [crop('first', 0), crop('second', 110)],
        seriesNameZh: '海洋系列',
        seriesNameEn: 'Ocean Series',
        existingEnglishNames: ['Old Name'],
        forbiddenEnglishNames: ['Historic Name']
      }
      const result = await new AliyunVisionService(settings).suggestImageNamesBatch(input)

      expect(result.items.map((item) => item.candidates[0]?.englishName)).toEqual(['Ocean Stars', 'Fresh Tide'])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const secondRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body)) as unknown
      expect(JSON.stringify(secondRequest)).toContain('Ocean Stars')
      expect(result.warnings).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('automatically falls back to single-image naming when all batch candidates are rejected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'casebang-naming-fallback-'))
    const imagePath = join(directory, 'pattern.png')
    try {
      await sharp({ create: { width: 110, height: 110, channels: 3, background: '#f5f5f5' } }).png().toFile(imagePath)
      const settings = {
        getCloudAiSettings: async () => ({
          provider: 'aliyun' as const,
          model: 'qwen3-vl-flash',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'test-key'
        })
      } as unknown as SettingsRepository
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(aiResponse([aiItem('I01', 'Ocean Series')]))
        .mockResolvedValueOnce(aiResponse([aiItem('I01', 'Ocean Series')]))
        .mockResolvedValueOnce(aiResponse([aiItem('I01', 'Ocean Series')]))
        .mockResolvedValueOnce(aiSingleResponse('Moonlit Cat'))

      const result = await new AliyunVisionService(settings).suggestImageNamesBatch({
        sourceImagePath: imagePath,
        crops: [crop('first', 0)],
        seriesNameZh: '海洋系列',
        seriesNameEn: 'Ocean Series',
        existingEnglishNames: [],
        forbiddenEnglishNames: []
      })

      expect(result.items[0]?.candidates[0]?.englishName).toBe('Moonlit Cat')
      expect(result.warnings).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function crop(id: string, x: number): CropBox {
  return {
    id, x, y: 0, width: 110, height: 110,
    role: 'product-pattern', label: id, productCategory: '磁吸背盖',
    suggestedRetailPrice: 89, overseasRetailPrice: 19.99, material: '',
    patternGroupId: null, confidence: 1, categoryConfidence: 1, categoryReasons: [],
    patternNameEn: 'Old Name', patternNameZh: '旧名称', nameCandidates: []
  }
}

function aiItem(imageId: string, englishName: string): object {
  return { imageId, englishName, chineseName: '测试名称', reason: '测试画面', confidence: 0.9 }
}

function aiResponse(items: object[]): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ items }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function aiSingleResponse(englishName: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ candidates: [
      { englishName, chineseName: '月光猫咪', reason: '猫咪主体', confidence: 0.92 },
      { englishName: 'Playful Whiskers', chineseName: '顽皮胡须', reason: '猫咪胡须', confidence: 0.88 },
      { englishName: 'Cozy Feline', chineseName: '温暖猫咪', reason: '温馨猫咪', confidence: 0.85 }
    ] }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
