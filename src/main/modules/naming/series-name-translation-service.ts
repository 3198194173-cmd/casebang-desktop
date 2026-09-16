import type { AiProvider, TranslateSeriesNameResult } from '@shared/contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'

const TRANSLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['englishName'],
  properties: { englishName: { type: 'string' } }
} as const

export async function translateSeriesName(settings: SettingsRepository, chineseName: string): Promise<TranslateSeriesNameResult> {
  const provider = 'aliyun' as const
  const prompt = buildPrompt(chineseName)
  if (!(await settings.getApplicationSettings()).allowNetworkFeatures) {
    throw new Error('联网功能已关闭。请在“系统设置”中开启后再使用云端翻译。')
  }
  const cloud = await settings.getCloudAiSettings()
  if (!cloud.apiKey) throw new Error('尚未配置阿里云百炼 API Key，无法执行系列名翻译。')
  const response = await request(`${cloud.baseUrl.replace(/\/+$/, '')}/chat/completions`, cloud.apiKey, {
    model: cloud.model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    enable_thinking: false,
    response_format: { type: 'json_schema', json_schema: { name: 'casebang_series_translation', strict: true, schema: TRANSLATION_SCHEMA } },
    temperature: 0,
    max_tokens: 100
  }, 60_000)
  const content = (response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content
  return result(provider, cloud.model, content)
}

function buildPrompt(chineseName: string): string {
  return [
    '你是产品系列名称的中译英翻译器。',
    '请忠实翻译，不要从历史表格匹配名称，不要根据图片或品牌猜测。',
    '英文要简洁自然，使用标题式大小写；专有名词采用通行译法。',
    '结果必须以 Series 结尾，并且只返回 JSON。',
    `待翻译中文系列名：${chineseName}`
  ].join('\n')
}

async function request(url: string, apiKey: string | null | undefined, body: object, timeout: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`系列名翻译失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 240)}` : ''}`)
  }
  return response.json()
}

function result(provider: AiProvider, model: string, content: string | undefined): TranslateSeriesNameResult {
  if (!content?.trim()) throw new Error('翻译服务没有返回英文系列名。')
  let englishName = ''
  try {
    englishName = String((JSON.parse(content.replace(/^```json\s*|\s*```$/gi, '').trim()) as { englishName?: string }).englishName ?? '')
  } catch {
    englishName = content.trim()
  }
  englishName = englishName.replace(/^['"]|['"]$/g, '').replace(/#[a-z]\d+.*$/i, '').trim()
  if (!englishName) throw new Error('翻译服务返回了空名称。')
  if (!/\bseries$/i.test(englishName)) englishName = `${englishName} Series`
  return { englishName, provider, model }
}
