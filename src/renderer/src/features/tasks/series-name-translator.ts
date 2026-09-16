import type { SeriesTranslation } from '@shared/contracts'

export interface SeriesTranslationSuggestion {
  englishName: string
  source: 'barcode-reference' | 'image-file' | 'local-dictionary'
}

const LOCAL_SERIES_DICTIONARY = new Map<string, string>(([
  ['汤姆和杰瑞', 'Tom and Jerry Series'],
  ['猫和老鼠', 'Tom and Jerry Series'],
  ['猫和老鼠1.0', 'Tom and Jerry Series'],
  ['猫和老鼠2.0', 'Tom and Jerry Series'],
  ['杭州限定', 'Hangzhou Limited Series'],
  ['玩具总动员', 'Toy Story Series'],
  ['轻松熊', 'Rilakkuma Series'],
  ['小熊维尼', 'Winnie the Pooh Series'],
  ['松松', 'Tsumtsum Series'],
  ['芋泥啵啵小熊', 'Sweet Bear Series'],
  ['秋冬猫猫', 'Cat Series'],
  ['蓝色海洋', 'Blue Ocean Series']
] as Array<[string, string]>).map(([chinese, english]) => [normalizeChineseSeriesName(chinese), english]))

const TRANSLATABLE_PARTS: Array<[string, string]> = [
  ['杭州', 'Hangzhou'], ['西湖', 'West Lake'], ['秋冬', 'Autumn Winter'], ['春夏', 'Spring Summer'],
  ['限定', 'Limited'], ['蓝色', 'Blue'], ['海洋', 'Ocean'], ['樱花', 'Cherry Blossom'],
  ['草莓', 'Strawberry'], ['花园', 'Garden'], ['梦境', 'Dream'], ['甜心', 'Sweetheart'],
  ['幸运', 'Lucky'], ['好运', 'Good Luck'], ['经典', 'Classic'], ['奇趣', 'Wonder'],
  ['简约', 'Minimal'], ['猫猫', 'Cats'], ['小熊', 'Bear']
]

export function suggestSeriesEnglishName(
  chineseName: string,
  imagePath: string,
  translations: SeriesTranslation[]
): SeriesTranslationSuggestion | null {
  const normalized = normalizeChineseSeriesName(chineseName)
  if (!normalized) return null

  const workbookMatch = translations.find((item) => normalizeChineseSeriesName(item.chineseName) === normalized)
  if (workbookMatch?.englishName.trim()) {
    return { englishName: cleanEnglishSeriesName(workbookMatch.englishName), source: 'barcode-reference' }
  }

  const dictionaryMatch = LOCAL_SERIES_DICTIONARY.get(normalized)
  if (dictionaryMatch) return { englishName: dictionaryMatch, source: 'local-dictionary' }

  const filenameMatch = extractSeriesPairFromImagePath(imagePath)
  if (filenameMatch && normalizeChineseSeriesName(filenameMatch.chineseName) === normalized) {
    return { englishName: filenameMatch.englishName, source: 'image-file' }
  }

  const composed = translateKnownParts(normalized)
  return composed ? { englishName: `${composed} Series`, source: 'local-dictionary' } : null
}

function extractSeriesPairFromImagePath(imagePath: string): { chineseName: string; englishName: string } | null {
  const fileName = imagePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? ''
  const match = /^(.+?)(?:#[a-z]\d+系列)?-([^-]+)/i.exec(fileName)
  if (!match?.[1] || !match[2] || !/[a-z]/i.test(match[1])) return null
  return { englishName: cleanEnglishSeriesName(match[1]), chineseName: match[2].trim() }
}

function translateKnownParts(value: string): string | null {
  let remainder = value
  const words: string[] = []
  while (remainder) {
    const part = TRANSLATABLE_PARTS.find(([chinese]) => remainder.startsWith(chinese))
    if (!part) return null
    words.push(part[1])
    remainder = remainder.slice(part[0].length)
  }
  return words.join(' ')
}

function cleanEnglishSeriesName(value: string): string {
  const cleaned = value.replace(/#[a-z]\d+.*$/i, '').trim()
  return /\bseries$/i.test(cleaned) ? cleaned : `${cleaned} Series`
}

function normalizeChineseSeriesName(value: string): string {
  return value.normalize('NFKC').trim().replace(/系列$/u, '').replace(/[\s·._\-–—()（）]+/g, '')
}
