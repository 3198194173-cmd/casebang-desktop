import type { DingTalkArtworkEntry } from './contracts'
import type { ArtworkSheetRow } from './lifecycle-contracts'
import { normalizeArtworkKey, parseArtworkFilename } from './artwork-comparison'

export function isPdf(entry: DingTalkArtworkEntry): boolean {
  return (entry.extension ?? '').toLowerCase().replace(/^\./, '') === 'pdf' || /\.pdf$/i.test(entry.name)
}

function ids(entry: DingTalkArtworkEntry): string[] {
  const publicNodeId = entry.nodeUrl.split('/').at(-1)
  return publicNodeId && publicNodeId !== entry.id ? [entry.id, decodeURIComponent(publicNodeId)] : [entry.id]
}

/** Series-root children are the actual product categories, whatever their names. */
export function categoryFolders(entries: DingTalkArtworkEntry[]): DingTalkArtworkEntry[] {
  const knownIds = new Set(entries.flatMap(ids))
  const folders = entries.filter(entry => /folder/i.test(entry.type))
  return folders.filter(entry => {
    if (entry.parentId && knownIds.has(entry.parentId)) return false
    const ownPath = pathParts(entry.path)
    return !folders.some(parent => parent.id !== entry.id && pathParts(parent.path).length > 0 &&
      pathParts(parent.path).length < ownPath.length && pathParts(parent.path).every((part, index) => ownPath[index] === part))
  })
}

function pathParts(value: string | null): string[] {
  return (value ?? '').normalize('NFKC').split('/').map(part => part.trim().toUpperCase()).filter(Boolean)
}

export function isUnder(entry: DingTalkArtworkEntry, folder: DingTalkArtworkEntry, entries: DingTalkArtworkEntry[]): boolean {
  const byId = new Map(entries.flatMap(item => ids(item).map(id => [id, item] as const)))
  let cursor = entry.parentId
  const visited = new Set<string>()
  while (cursor && !visited.has(cursor)) {
    if (ids(folder).includes(cursor)) return true
    visited.add(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  if (entry.parentId && byId.has(entry.parentId)) return false
  const parentPath = pathParts(folder.path)
  const candidatePath = pathParts(entry.path)
  const prefix = parentPath.length ? parentPath : [folder.name.normalize('NFKC').toUpperCase()]
  return prefix.length > 0 && candidatePath.length > prefix.length && prefix.every((part, index) => candidatePath[index] === part)
}

export function modelFolders(entries: DingTalkArtworkEntry[], category: DingTalkArtworkEntry): DingTalkArtworkEntry[] {
  const pdfParents = new Set(entries.filter(isPdf).map(entry => entry.parentId).filter((id): id is string => !!id))
  return entries.filter(entry => /folder/i.test(entry.type) && entry.id !== category.id && isUnder(entry, category, entries) && ids(entry).some(id => pdfParents.has(id)))
}

export function selectedPdfs(entries: DingTalkArtworkEntry[], category: DingTalkArtworkEntry | null, model: DingTalkArtworkEntry | null): DingTalkArtworkEntry[] {
  if (!category) return []
  const selected = model ?? category
  return entries.filter(entry => isPdf(entry) && ((entry.parentId && ids(selected).includes(entry.parentId)) || (!entry.parentId && pathParts(entry.path).at(-2) === selected.name.normalize('NFKC').toUpperCase())))
}

export interface ArtworkComparisonRow {
  key: string
  pdf: DingTalkArtworkEntry
  alternatives: DingTalkArtworkEntry[]
  row: ArtworkSheetRow | null
  issue: string | null
}

export function buildArtworkComparisons(pdfs: DingTalkArtworkEntry[], workbookRows: ArtworkSheetRow[], selectedPdfIds: Record<string, string> = {}): ArtworkComparisonRow[] {
  const groups = new Map<string, DingTalkArtworkEntry[]>()
  for (const pdf of pdfs) {
    const code = normalizeArtworkKey(parseArtworkFilename(pdf.name).productCode ?? '')
    const key = code || `FILE:${pdf.id}`
    groups.set(key, [...(groups.get(key) ?? []), pdf])
  }
  return [...groups].map(([key, files]) => {
    const pdf = files.find(file => file.id === selectedPdfIds[key]) ?? files[0]!
    const parsed = parseArtworkFilename(pdf.name)
    const code = normalizeArtworkKey(parsed.productCode ?? '')
    const matches = workbookRows.filter(row => code && normalizeArtworkKey(row.productCode) === code)
    const row = matches[0] ?? null
    let issue: string | null = null
    if (files.length > 1 && !selectedPdfIds[key]) issue = `同一产品编码有 ${files.length} 份 PDF，请选择主文件`
    else if (!code) issue = 'PDF 文件名未解析出产品编码'
    else if (!row) issue = '图片分表没有对应产品编码'
    else if (matches.some(other => normalizeArtworkKey(other.patternNameUpper || other.patternName) !== normalizeArtworkKey(row.patternNameUpper || row.patternName))) issue = '同一产品编码有多个图案名称'
    else if (parsed.normalizedPatternKey && normalizeArtworkKey(row.patternNameUpper || row.patternName) !== parsed.normalizedPatternKey) issue = 'PDF 文件名与图片分表图案名称冲突'
    else if (!row.imageDataUrl) issue = '图片分表该行没有截图'
    return { key, pdf, alternatives: files.filter(file => file.id !== pdf.id), row, issue }
  })
}
