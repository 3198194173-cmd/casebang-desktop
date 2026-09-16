import { describe, expect, it } from 'vitest'
import { saveAiSettingsInputSchema } from '../src/shared/schemas'
import { validateAliyunBaseUrl } from '../src/main/modules/naming/aliyun-vision-service'

const baseInput = {
  model: 'qwen3-vl-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: ''
}

describe('Aliyun Bailian provider configuration', () => {
  it('accepts Aliyun Bailian as the only provider', () => {
    expect(saveAiSettingsInputSchema.safeParse({ ...baseInput, provider: 'aliyun' }).success).toBe(true)
    expect(saveAiSettingsInputSchema.safeParse({ ...baseInput, provider: 'openai' }).success).toBe(false)
    expect(saveAiSettingsInputSchema.safeParse({ ...baseInput, provider: 'local-ollama' }).success).toBe(false)
  })

  it('only accepts an aliyuncs.com HTTPS endpoint', () => {
    expect(() => validateAliyunBaseUrl(baseInput.baseUrl)).not.toThrow()
    expect(() => validateAliyunBaseUrl('https://api.openai.com/v1')).toThrow()
    expect(() => validateAliyunBaseUrl('http://dashscope.aliyuncs.com/compatible-mode/v1')).toThrow()
  })
})
