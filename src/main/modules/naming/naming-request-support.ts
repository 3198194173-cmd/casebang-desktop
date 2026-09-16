import { access, realpath, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import type { ImageNameCandidate, SuggestImageNamesBatchInput, SuggestImageNamesInput } from '@shared/image-contracts'
import { sanitizeEnglishPatternName } from '@shared/pattern-name'

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'])

export const NAME_RESPONSE_SCHEMA = z.object({
  candidates: z.array(z.object({
    englishName: z.string().trim().min(1).max(80),
    chineseName: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(180),
    confidence: z.number().min(0).max(1)
  })).min(1).max(3)
})

export const NAME_JSON_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          englishName: { type: 'string' },
          chineseName: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['englishName', 'chineseName', 'reason', 'confidence'],
        additionalProperties: false
      }
    }
  },
  required: ['candidates'],
  additionalProperties: false
} as const

const BATCH_RESPONSE_SCHEMA = z.object({
  items: z.array(z.object({
    imageId: z.string().trim().min(1).max(10),
    englishName: z.string().trim().min(1).max(80),
    chineseName: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(180),
    confidence: z.number().min(0).max(1)
  })).min(1).max(24)
})

export const NAME_BATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        properties: {
          imageId: { type: 'string' },
          englishName: { type: 'string' },
          chineseName: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['imageId', 'englishName', 'chineseName', 'reason', 'confidence'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
} as const

export async function createCropPreview(
  input: Pick<SuggestImageNamesInput, 'sourceImagePath' | 'crop'>,
  options: { maxDimension?: number; quality?: number } = {}
): Promise<Buffer> {
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extname(input.sourceImagePath).toLocaleLowerCase())) {
    throw new Error('AI 命名仅支持常用图片格式')
  }
  await access(input.sourceImagePath)
  const safePath = await realpath(input.sourceImagePath)
  const file = await stat(safePath)
  if (!file.isFile()) throw new Error('AI 命名图片路径无效')

  const metadata = await sharp(safePath).metadata()
  if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸')
  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8
  const width = rotated ? metadata.height : metadata.width
  const height = rotated ? metadata.width : metadata.height
  const crop = input.crop
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > width || crop.y + crop.height > height) {
    throw new Error('当前裁剪区域超出原图范围')
  }

  return sharp(safePath)
    .rotate()
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .resize({ width: options.maxDimension ?? 1_024, height: options.maxDimension ?? 1_024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: options.quality ?? 84, mozjpeg: true })
    .toBuffer()
}

export async function createContactSheetPreview(
  sourceImagePath: string,
  crops: SuggestImageNamesBatchInput['crops'],
  imageIds: string[]
): Promise<Buffer> {
  const columns = Math.min(crops.length <= 6 ? 3 : 4, crops.length)
  const rows = Math.ceil(crops.length / columns)
  const tileWidth = 320
  const tileHeight = 360
  const labelHeight = 32
  const imageWidth = tileWidth - 16
  const imageHeight = tileHeight - labelHeight - 12
  const tiles = await Promise.all(crops.map(async (crop) => {
    const preview = await createCropPreview({ sourceImagePath, crop }, { maxDimension: 512, quality: 78 })
    return sharp(preview)
      .resize({ width: imageWidth, height: imageHeight, fit: 'contain', background: '#ffffff' })
      .png()
      .toBuffer()
  }))
  const width = columns * tileWidth
  const height = rows * tileHeight
  const labels = imageIds.map((imageId, index) => {
    const x = index % columns * tileWidth
    const y = Math.floor(index / columns) * tileHeight
    return `<rect x="${x + 8}" y="${y + 5}" width="56" height="24" rx="5" fill="#1677a8"/><text x="${x + 36}" y="${y + 22}" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="white">${imageId}</text>`
  }).join('')
  const separators = imageIds.map((_, index) => {
    const x = index % columns * tileWidth
    const y = Math.floor(index / columns) * tileHeight
    return `<rect x="${x + 2}" y="${y + 2}" width="${tileWidth - 4}" height="${tileHeight - 4}" rx="8" fill="none" stroke="#b7c7cc" stroke-width="2"/>`
  }).join('')
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${separators}${labels}</svg>`)
  const composites = tiles.map((tile, index) => ({
    input: tile,
    left: index % columns * tileWidth + 8,
    top: Math.floor(index / columns) * tileHeight + labelHeight
  }))

  return sharp({ create: { width, height, channels: 3, background: '#f4f7f7' } })
    .composite([...composites, { input: overlay, left: 0, top: 0 }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()
}

export function buildNamingPrompt(input: SuggestImageNamesInput): string {
  const existing = input.existingEnglishNames.length > 0 ? input.existingEnglishNames.join('、') : '暂无'
  return [
    '你是 CASEBANG 商品图案命名助手。输入图片是从系列大图中裁出的一个独立产品/图案区域，不是让你概括整个系列。',
    '',
    `中文系列名（仅作背景，不可直接作为答案）：${input.seriesNameZh}`,
    `英文系列名（仅作背景，不可直接作为答案）：${input.seriesNameEn || '尚未填写'}`,
    `产品类型（只帮助理解载体，不可写入名称）：${input.crop.productCategory}`,
    `本系列已使用英文图案名（禁止重复或近似重复）：${existing}`,
    '',
    '任务：根据裁图中最显著的角色/主体、动作、物件、场景、构图或特色颜色，给出 3 组互不相同的候选图案名称。名称只取决于图案，不取决于承载图案的产品类型。',
    namingStyleReference(),
    '命名规则：',
    '1. 英文名为自然的 Title Case，使用 2–3 个英文单词，不超过 3 个单词，像商品款式名，不写成句子；避免 in the、with the 等冗长表达。',
    '2. 英文名只能包含英文字母 A–Z、a–z 和单词之间的空格。禁止使用连字符“-”、下划线、撇号、数字、斜杠、标点、Emoji 或任何其他符号；不要使用所有格缩写。',
    '3. 必须描述这一张具体图案的差异点；不得只返回系列/IP 名，例如 Tom and Jerry、Tom and Jerry Series。',
    '4. 不得包含 Series、系列编号、Phone Case、手机壳、充电宝、卡包或其他产品类型；相同图案用于不同产品时应使用同一个名称。',
    '5. 每个英文名必须配一个含义对应的简短中文名；reason 用一句中文说明画面依据。',
    '6. 画面含多个小图时，按整体构图或共同主题命名；看不清角色身份时描述可见特征，不得编造角色名。',
    '7. 三个候选必须明显不同，且不得与已使用名称重复。confidence 为 0 到 1。',
    '只返回符合指定结构的 JSON，不要说明过程，不要添加 Markdown。'
  ].join('\n')
}

export function buildBatchNamingPrompt(
  input: SuggestImageNamesBatchInput,
  imageIds: string[],
  presentation: 'contact-sheet' | 'separate-images' = 'contact-sheet'
): string {
  const existing = input.existingEnglishNames.length > 0 ? input.existingEnglishNames.join('、') : '暂无'
  const imageLines = input.crops.map((crop, index) => `${imageIds[index]}：第 ${index + 1} 张图片，产品类型 ${crop.productCategory}`).join('\n')
  return [
    presentation === 'separate-images'
      ? '你是 CASEBANG 商品图案命名助手。接下来按 I01、I02 等编号依次提供多张彼此独立的裁剪图。每张只生成 1 个最合适的名称。'
      : '你是 CASEBANG 商品图案命名助手。图片是一张临时联系表，里面每个带 I01、I02 等蓝色编号框的格子，都是彼此独立的裁剪图。每格只生成 1 个最合适的名称。',
    `中文系列名（仅作背景，不可作为答案）：${input.seriesNameZh}`,
    `英文系列名（仅作背景，不可作为答案）：${input.seriesNameEn || '尚未填写'}`,
    `本系列已使用名称（不同图案不得重复；同一视觉图案跨产品可以共用）：${existing}`,
    imageLines,
    namingStyleReference(),
    '规则：',
    '1. 每张图片必须返回一项，imageId 必须原样使用对应编号，不可漏图、串图或合并图片。',
    '2. 英文名使用 Title Case，使用 2–3 个英文单词，不超过 3 个单词，直接描述主体、动作、物件、构图或特色；不写完整句子，不使用 in the、with the 等冗长结构。',
    '3. 英文名只能包含英文字母 A–Z、a–z 和单词之间的空格。禁止连字符“-”、下划线、撇号、数字、斜杠、标点、Emoji 或任何其他符号。',
    '4. 多图/贴纸/照片格使用 Grid、Collage、Wall、Board、Stickers、Party 等整体构图词，不要逐个描述所有小图。',
    '5. 单头像优先使用“可见主体 + Face”；剪影可使用 Silhouette；互动场景使用与本图细节匹配的简短动作或情绪组合，不得照抄历史款式名。',
    '6. 命名只根据图案，不根据产品类型。若磁吸充电宝与自带线充电宝使用相同图案，必须返回完全相同的中英文名。',
    '7. 磁吸支架背盖与磁吸气囊支架按图案顺序成对：同一图案的一对产品必须返回完全相同的中英文名。',
    '8. 只有画面图案确实相同时才允许重名；不同图案必须使用不同名称。禁止只返回系列/IP 名、Series、系列编号或任何产品类型。',
    '9. 中文名与英文名含义对应，reason 最多 20 个中文字，只写最关键画面依据，confidence 为 0 到 1。',
    '严格返回指定 JSON，不要解释过程，不要 Markdown。'
  ].join('\n')
}

export function parseNameCandidates(rawContent: string, input: SuggestImageNamesInput): ImageNameCandidate[] {
  const parsed = NAME_RESPONSE_SCHEMA.parse(JSON.parse(stripCodeFence(rawContent)))
  const existing = new Set(
    [...input.existingEnglishNames, ...(input.forbiddenEnglishNames ?? [])].map(normalizeName)
  )
  const genericSeriesNames = buildGenericSeriesNames(input.seriesNameEn)
  const returned = new Set<string>()

  const candidates = parsed.candidates.flatMap((candidate) => {
    const englishName = sanitizeEnglishPatternName(candidate.englishName)
    const normalized = normalizeName(englishName)
    if (!normalized || existing.has(normalized) || returned.has(normalized) || genericSeriesNames.has(normalized)) return []
    returned.add(normalized)
    return [{ ...candidate, englishName }]
  })

  if (candidates.length === 0) {
    throw new Error('AI 只给出了系列名或与本系列已有名称重复，请重新识别或手工填写。')
  }
  return candidates
}

export function parseBatchNameCandidates(
  rawContent: string,
  input: SuggestImageNamesBatchInput,
  imageIds: string[]
): Array<{ cropId: string; candidate: ImageNameCandidate }> {
  return parseBatchNameCandidatesDetailed(rawContent, input, imageIds).accepted
}

export interface ParsedBatchNameCandidates {
  accepted: Array<{ cropId: string; candidate: ImageNameCandidate }>
  /** AI 已提出但因冲突而被拒绝的名称，可在下一轮请求中明确要求避开。 */
  rejectedEnglishNames: string[]
}

export function parseBatchNameCandidatesDetailed(
  rawContent: string,
  input: SuggestImageNamesBatchInput,
  imageIds: string[]
): ParsedBatchNameCandidates {
  const parsed = BATCH_RESPONSE_SCHEMA.parse(JSON.parse(stripCodeFence(rawContent)))
  const cropByImageId = new Map(imageIds.map((imageId, index) => [normalizeBatchImageId(imageId), input.crops[index]]))
  const existing = new Set(
    [...input.existingEnglishNames, ...(input.forbiddenEnglishNames ?? [])].map(normalizeName)
  )
  const generic = buildGenericSeriesNames(input.seriesNameEn)
  const accepted: Array<{ cropId: string; candidate: ImageNameCandidate }> = []
  const rejectedEnglishNames = new Set<string>()
  const returnedImageIds = new Set<string>()
  const categoriesByReturnedName = new Map<string, Set<string>>()

  for (const item of parsed.items) {
    const normalizedImageId = normalizeBatchImageId(item.imageId)
    const crop = cropByImageId.get(normalizedImageId)
    const englishName = sanitizeEnglishPatternName(item.englishName)
    const normalized = normalizeName(englishName)
    if (!crop || returnedImageIds.has(normalizedImageId)) {
      if (englishName) rejectedEnglishNames.add(englishName)
      continue
    }
    returnedImageIds.add(normalizedImageId)
    if (!normalized || existing.has(normalized) || generic.has(normalized)) {
      if (englishName) rejectedEnglishNames.add(englishName)
      continue
    }

    const categories = categoriesByReturnedName.get(normalized) ?? new Set<string>()
    // 同一批次中，同产品类别的不同图案必须唯一；不同载体可以共享同一视觉名称，
    // 渲染端会据此把它们归入同一个图案组，而不会合并产品记录。
    if (categories.has(crop.productCategory)) {
      rejectedEnglishNames.add(englishName)
      continue
    }
    categories.add(crop.productCategory)
    categoriesByReturnedName.set(normalized, categories)
    accepted.push({
      cropId: crop.id,
      candidate: {
        englishName,
        chineseName: item.chineseName,
        reason: item.reason,
        confidence: item.confidence
      }
    })
  }
  return { accepted, rejectedEnglishNames: [...rejectedEnglishNames] }
}

function namingStyleReference(): string {
  return '命名风格应贴近商品款式名：短、具体、可区分。英文严格控制在2–3个单词；只保留主体和一个最重要特征，不罗列多个主体、背景或方位。侧边版等生产信息放在reason，不写入英文款式名。例如应采用 Jellyfish Dance，而不是 Side Jellyfish and Starfish Ocean。优先使用画面主体、动作、情绪、物件或构图方式组成自然英文短语；不要照抄任何示例或历史名称，也不要写成图片说明句。'
}

function buildGenericSeriesNames(seriesName: string): Set<string> {
  const normalized = normalizeName(seriesName)
  const withoutCode = normalizeName(seriesName.replace(/#[a-z]\d+.*$/i, ''))
  const withoutSeries = normalizeName(seriesName.replace(/\bseries\b.*$/i, ''))
  return new Set([normalized, withoutCode, withoutSeries].filter(Boolean))
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Qwen occasionally returns `I1`, `i01` or `Image I01` even when the schema
 * asks it to echo `I01`. Treat those harmless formatting differences as the
 * same id so a valid name is not discarded with the whole batch.
 */
function normalizeBatchImageId(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleUpperCase('en-US')
  const match = normalized.match(/(?:^|\b)(?:IMAGE\s*)?I?\s*0*(\d{1,3})(?:\b|$)/)
  if (!match) return normalized.replace(/\s+/g, '')
  const number = Number(match[1])
  return Number.isInteger(number) && number > 0 ? `I${String(number).padStart(2, '0')}` : normalized.replace(/\s+/g, '')
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}
