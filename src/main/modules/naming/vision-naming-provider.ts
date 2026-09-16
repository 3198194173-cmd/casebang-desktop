import type { SuggestImageNamesInput, SuggestImageNamesResult } from '@shared/image-contracts'

export interface VisionNamingProvider {
  readonly providerId: string
  suggestImageNames(request: SuggestImageNamesInput): Promise<SuggestImageNamesResult>
}

export class UnconfiguredVisionNamingProvider implements VisionNamingProvider {
  readonly providerId = 'unconfigured'

  async suggestImageNames(): Promise<SuggestImageNamesResult> {
    throw new Error('尚未配置视觉 AI。请先在接口中心选择服务商并填写 API Key。')
  }
}
