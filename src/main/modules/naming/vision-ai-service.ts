import { fixedMaterial, type MaterialInput, type MaterialResult } from '@shared/material-recognition'
import type { ComparePatternsInput, ComparePatternsResult } from '@shared/pattern-comparison'
import type { ArtworkVisualInput, ArtworkVisualResult } from '@shared/artwork-ai'
import type { AiSettingsSummary, SaveAiSettingsInput, TranslateSeriesNameResult } from '@shared/contracts'
import type { SuggestImageNamesBatchInput, SuggestImageNamesBatchResult, SuggestImageNamesInput, SuggestImageNamesResult } from '@shared/image-contracts'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'
import { AliyunVisionService, validateAliyunBaseUrl } from './aliyun-vision-service'
import { translateSeriesName } from './series-name-translation-service'

const ALIYUN_MODELS = new Set(['qwen3-vl-flash', 'qwen3-vl-plus', 'qwen-vl-plus'])

export class VisionAiService {
  private readonly aliyun: AliyunVisionService

  constructor(private readonly settings: SettingsRepository) {
    this.aliyun = new AliyunVisionService(settings)
  }

  getSettings(): Promise<AiSettingsSummary> {
    return this.settings.getAiSettingsSummary()
  }

  async saveSettings(input: SaveAiSettingsInput): Promise<AiSettingsSummary> {
    validateAliyunBaseUrl(input.baseUrl)
    if (!ALIYUN_MODELS.has(input.model)) throw new Error('当前版本不支持该阿里云视觉模型')
    return this.settings.setAiSettings(input)
  }

  async recognizeMaterial(input: MaterialInput): Promise<MaterialResult> {
    const material = fixedMaterial(input.crop.productCategory)
    if (material) return { material, confidence: 1, reason: '按支架类别固定规则填写' }
    return (await this.activeProvider()).recognizeMaterial(input)
  }

  async comparePatterns(input: ComparePatternsInput): Promise<ComparePatternsResult> {
    return (await this.activeProvider()).comparePatterns(input)
  }

  async compareArtworkImages(input: ArtworkVisualInput): Promise<ArtworkVisualResult> {
    return (await this.activeProvider()).compareArtworkImages(input)
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return (await this.activeProvider()).testConnection()
  }

  async suggestImageNames(input: SuggestImageNamesInput): Promise<SuggestImageNamesResult> {
    if (input.crop.role === 'series-overview') throw new Error('全系列主图不需要生成图案名称。')
    return (await this.activeProvider()).suggestImageNames(input)
  }

  async suggestImageNamesBatch(input: SuggestImageNamesBatchInput): Promise<SuggestImageNamesBatchResult> {
    const provider = await this.activeProvider()
    return provider.suggestImageNamesBatch(input)
  }

  translateSeriesName(chineseName: string): Promise<TranslateSeriesNameResult> {
    return translateSeriesName(this.settings, chineseName)
  }

  private async activeProvider(): Promise<AliyunVisionService> {
    if (!(await this.settings.getApplicationSettings()).allowNetworkFeatures) {
      throw new Error('联网功能已关闭。请在“系统设置”中开启后再使用云端 AI。')
    }
    return this.aliyun
  }
}
