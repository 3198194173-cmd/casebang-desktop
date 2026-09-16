import { describe, expect, it } from 'vitest'
import type { SuggestImageNamesBatchInput, SuggestImageNamesInput } from '../src/shared/image-contracts'
import {
  buildBatchNamingPrompt,
  buildNamingPrompt,
  parseBatchNameCandidates,
  parseBatchNameCandidatesDetailed,
  parseNameCandidates
} from '../src/main/modules/naming/naming-request-support'

const REQUEST: SuggestImageNamesInput = {
  sourceImagePath: 'C:\\images\\tom-and-jerry.png',
  crop: {
    id: 'crop-1', x: 10, y: 20, width: 300, height: 500,
    role: 'product-pattern', label: '图案 1', productCategory: '磁吸背盖',
    suggestedRetailPrice: 89, overseasRetailPrice: 19.99, material: '',
    patternGroupId: null, confidence: 0.9, categoryConfidence: 0.8,
    categoryReasons: [], patternNameEn: '', patternNameZh: '', nameCandidates: []
  },
  seriesNameZh: '猫和老鼠1.0系列',
  seriesNameEn: 'Tom and Jerry Series#J1系列',
  existingEnglishNames: ['Cheese Chase']
}

describe('AI naming request support', () => {
  it('tells the model to name the cropped pattern instead of the series', () => {
    const prompt = buildNamingPrompt(REQUEST)
    expect(prompt).toContain('一个独立产品/图案区域')
    expect(prompt).toContain('不可直接作为答案')
    expect(prompt).toContain('不得只返回系列/IP 名')
    expect(prompt).toContain('Cheese Chase')
    expect(prompt).toContain('不要照抄任何示例或历史名称')
    expect(prompt).not.toContain('Photo Wall')
    expect(buildBatchNamingPrompt({ ...REQUEST, crops: [REQUEST.crop] }, ['I01'])).not.toContain('Warm Hug')
    expect(prompt).toContain('2–3 个英文单词')
    expect(buildBatchNamingPrompt({ ...REQUEST, crops: [REQUEST.crop] }, ['I01'])).toContain('不超过 3 个单词')
    expect(prompt).toContain('禁止使用连字符')
  })

  it('removes every non-letter symbol from AI English names before use', () => {
    const candidates = parseNameCandidates(JSON.stringify({ candidates: [
      { englishName: 'Moon-Star_2!', chineseName: '月亮星星', reason: '月亮和星星图案', confidence: 0.91 }
    ] }), REQUEST)
    expect(candidates[0]?.englishName).toBe('Moon Star')
    expect(candidates[0]?.englishName).toMatch(/^[A-Za-z]+(?: [A-Za-z]+)*$/)
  })

  it('filters a generic series answer and keeps specific candidates', () => {
    const candidates = parseNameCandidates(JSON.stringify({ candidates: [
      { englishName: 'Tom and Jerry', chineseName: '猫和老鼠', reason: '系列名称', confidence: 0.99 },
      { englishName: 'Cheese Daydream', chineseName: '奶酪幻想', reason: '黄色奶酪背景', confidence: 0.91 },
      { englishName: 'Playful Chase', chineseName: '欢乐追逐', reason: '角色正在互动', confidence: 0.88 }
    ] }), REQUEST)
    expect(candidates.map((item) => item.englishName)).toEqual(['Cheese Daydream', 'Playful Chase'])
  })

  it('filters names already used in the same series', () => {
    const candidates = parseNameCandidates(JSON.stringify({ candidates: [
      { englishName: 'Cheese Chase', chineseName: '奶酪追逐', reason: '重复名称', confidence: 0.9 },
      { englishName: 'Comic Memories', chineseName: '漫画回忆', reason: '多格漫画构图', confidence: 0.85 }
    ] }), REQUEST)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.englishName).toBe('Comic Memories')
  })

  it('maps batch image ids back to crop ids and preserves repeated names for identical patterns', () => {
    const batch: SuggestImageNamesBatchInput = {
      sourceImagePath: REQUEST.sourceImagePath,
      crops: [REQUEST.crop, { ...REQUEST.crop, id: 'crop-2', label: '图案 2', productCategory: 'CP002磁吸充电宝' }],
      seriesNameZh: REQUEST.seriesNameZh,
      seriesNameEn: REQUEST.seriesNameEn,
      existingEnglishNames: ['Cheese Chase']
    }
    const prompt = buildBatchNamingPrompt(batch, ['I01', 'I02'])
    expect(prompt).toContain('每格只生成 1 个最合适的名称')
    expect(prompt).toContain('I01：第 1 张图片')
    expect(buildBatchNamingPrompt(batch, ['I01', 'I02'], 'separate-images')).toContain('多张彼此独立的裁剪图')
    const results = parseBatchNameCandidates(JSON.stringify({ items: [
      { imageId: 'I01', englishName: 'Photo Wall', chineseName: '照片墙', reason: '多格照片构图', confidence: 0.92 },
      { imageId: 'I02', englishName: 'Photo Wall', chineseName: '照片墙', reason: '重复名称', confidence: 0.8 }
    ] }), batch, ['I01', 'I02'])
    expect(results).toHaveLength(2)
    expect(results[0]?.cropId).toBe('crop-1')
    expect(results[1]?.cropId).toBe('crop-2')
  })

  it('rejects duplicate names inside the same product category so they can be retried', () => {
    const batch: SuggestImageNamesBatchInput = {
      sourceImagePath: REQUEST.sourceImagePath,
      crops: [REQUEST.crop, { ...REQUEST.crop, id: 'crop-2', label: '图案 2' }],
      seriesNameZh: REQUEST.seriesNameZh,
      seriesNameEn: REQUEST.seriesNameEn,
      existingEnglishNames: []
    }
    const parsed = parseBatchNameCandidatesDetailed(JSON.stringify({ items: [
      { imageId: 'I01', englishName: 'Ocean Friends', chineseName: '海洋朋友', reason: '图案一', confidence: 0.9 },
      { imageId: 'I02', englishName: 'Ocean Friends', chineseName: '海洋朋友', reason: '图案二', confidence: 0.9 }
    ] }), batch, ['I01', 'I02'])
    expect(parsed.accepted).toHaveLength(1)
    expect(parsed.rejectedEnglishNames).toEqual(['Ocean Friends'])
  })

  it('uses the complete local history as a forbidden-name set without adding it to the prompt', () => {
    const request = { ...REQUEST, forbiddenEnglishNames: ['Historic Pattern'] }
    const candidates = parseNameCandidates(JSON.stringify({ candidates: [
      { englishName: 'Historic Pattern', chineseName: '历史名称', reason: '重复名称', confidence: 0.9 },
      { englishName: 'Fresh Pattern', chineseName: '全新名称', reason: '新名称', confidence: 0.9 }
    ] }), request)
    expect(candidates.map((candidate) => candidate.englishName)).toEqual(['Fresh Pattern'])
    expect(buildNamingPrompt(request)).not.toContain('Historic Pattern')
  })

  it('accepts at most one result for each image id', () => {
    const batch: SuggestImageNamesBatchInput = {
      sourceImagePath: REQUEST.sourceImagePath,
      crops: [REQUEST.crop],
      seriesNameZh: REQUEST.seriesNameZh,
      seriesNameEn: REQUEST.seriesNameEn,
      existingEnglishNames: []
    }
    const parsed = parseBatchNameCandidatesDetailed(JSON.stringify({ items: [
      { imageId: 'I01', englishName: 'First Pattern', chineseName: '第一个', reason: '第一项', confidence: 0.9 },
      { imageId: 'I01', englishName: 'Second Pattern', chineseName: '第二个', reason: '重复编号', confidence: 0.8 }
    ] }), batch, ['I01'])
    expect(parsed.accepted).toHaveLength(1)
    expect(parsed.accepted[0]?.candidate.englishName).toBe('First Pattern')
  })

  it('accepts harmless Qwen variations of the requested image ids', () => {
    const batch: SuggestImageNamesBatchInput = {
      sourceImagePath: REQUEST.sourceImagePath,
      crops: [REQUEST.crop, { ...REQUEST.crop, id: 'crop-2', label: '图案 2', productCategory: 'CP002磁吸充电宝' }],
      seriesNameZh: REQUEST.seriesNameZh,
      seriesNameEn: REQUEST.seriesNameEn,
      existingEnglishNames: []
    }
    const parsed = parseBatchNameCandidatesDetailed(JSON.stringify({ items: [
      { imageId: 'i1', englishName: 'Playful Cat', chineseName: '顽皮猫咪', reason: '猫咪主体', confidence: 0.9 },
      { imageId: 'Image I02', englishName: 'Bright Mouse', chineseName: '明亮小鼠', reason: '小鼠主体', confidence: 0.9 }
    ] }), batch, ['I01', 'I02'])
    expect(parsed.accepted.map((item) => item.cropId)).toEqual(['crop-1', 'crop-2'])
  })

  it('accepts a complete maximum-size 24-region batch response', () => {
    const crops = Array.from({ length: 24 }, (_, index) => ({
      ...REQUEST.crop,
      id: `crop-${index + 1}`,
      label: `图案 ${index + 1}`
    }))
    const batch: SuggestImageNamesBatchInput = {
      sourceImagePath: REQUEST.sourceImagePath,
      crops,
      seriesNameZh: REQUEST.seriesNameZh,
      seriesNameEn: REQUEST.seriesNameEn,
      existingEnglishNames: []
    }
    const imageIds = crops.map((_, index) => `I${String(index + 1).padStart(2, '0')}`)
    const suffixes = [
      'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet',
      'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra',
      'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray'
    ]
    const raw = JSON.stringify({ items: imageIds.map((imageId, index) => ({
      imageId,
      englishName: `Pattern ${suffixes[index]}`,
      chineseName: `图案 ${index + 1}`,
      reason: '测试批量映射',
      confidence: 0.9
    })) })

    expect(parseBatchNameCandidates(raw, batch, imageIds)).toHaveLength(24)
  })
})
