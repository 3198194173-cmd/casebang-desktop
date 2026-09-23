import { describe, expect, it } from 'vitest'
import type { DingTalkArtworkEntry } from '../src/shared/contracts'
import type { ArtworkSheetRow } from '../src/shared/lifecycle-contracts'
import { buildArtworkComparisons, categoryFolders, modelFolders, selectedPdfs } from '../src/shared/artwork-selection'

const entry = (id: string, parentId: string | null, name: string, type = 'FILE'): DingTalkArtworkEntry => ({
  id, parentId, name, type, nodeUrl: `https://alidocs.dingtalk.com/i/nodes/${id}`, extension: type === 'FILE' ? 'pdf' : null,
  sizeBytes: null, version: 1, path: null, modifiedAt: null
})
const sheetRow = (code: string, pattern: string): ArtworkSheetRow => ({
  id: code, sheet: '可拆卸图片', row: 2, productCode: code, barcodeName: '磁吸背盖', patternName: pattern,
  patternNameUpper: pattern, artworkFileName: '', imageDataUrl: 'data:image/png;base64,AAAA'
})

describe('artwork folder selection', () => {
  it('never includes 17PROMAX when 17PRO is selected', () => {
    const category = entry('category', 'root', '可拆卸', 'FOLDER')
    const pro = entry('pro', 'category', '苹果17PRO', 'FOLDER')
    const max = entry('max', 'category', '苹果17PROMAX', 'FOLDER')
    const proPdf = entry('p1', 'pro', '可拆卸-苹果17PRO#BG00733#CHARACTERCIRCLE.pdf')
    const maxPdf = entry('p2', 'max', '可拆卸-苹果17PROMAX#BG00733#CHARACTERCIRCLE.pdf')
    const entries = [category, pro, max, proPdf, maxPdf]
    expect(categoryFolders(entries).map(item => item.id)).toEqual(['category'])
    expect(modelFolders(entries, category).map(item => item.id)).toEqual(['pro', 'max'])
    expect(selectedPdfs(entries, category, pro).map(item => item.id)).toEqual(['p1'])
  })

  it('supports a category with direct PDFs and no model', () => {
    const category = entry('stand', 'root', '支架', 'FOLDER')
    const pdf = entry('file', 'stand', '支架#ZJBG00335#BEAR&PALS.pdf')
    expect(modelFolders([category, pdf], category)).toEqual([])
    expect(selectedPdfs([category, pdf], category, null)).toEqual([pdf])
  })

  it('accepts DingTalk UUID parent references without broad name matching', () => {
    const category = { ...entry('category', 'root', '一体壳', 'FOLDER'), nodeUrl: 'https://alidocs.dingtalk.com/i/nodes/category-uuid' }
    const model = { ...entry('model', 'category-uuid', '17PRO', 'FOLDER'), nodeUrl: 'https://alidocs.dingtalk.com/i/nodes/model-uuid' }
    const pdf = entry('pdf', 'model-uuid', '出镜壳#BG00733#CHARACTERCIRCLE.pdf')
    expect(modelFolders([category, model, pdf], category).map(item => item.id)).toEqual(['model'])
    expect(selectedPdfs([category, model, pdf], category, model)).toEqual([pdf])
  })
})

describe('artwork pairing', () => {
  it('groups duplicate material PDFs under one product-code row', () => {
    const a = entry('a', 'pro', '可拆卸-透明片材#BG00733#CHARACTERCIRCLE.pdf')
    const b = entry('b', 'pro', '可拆卸-闪粉片材#BG00733#CHARACTERCIRCLE.pdf')
    const rows = buildArtworkComparisons([a, b], [sheetRow('BG00733', 'CHARACTERCIRCLE')])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.alternatives).toEqual([b])
    expect(rows[0]?.issue).toMatch(/2 份 PDF/)
    const chosen = buildArtworkComparisons([a, b], [sheetRow('BG00733', 'CHARACTERCIRCLE')], { BG00733: 'b' })
    expect(chosen[0]?.pdf.id).toBe('b')
    expect(chosen[0]?.issue).toBeNull()
  })

  it('rejects a matching code with conflicting uppercase artwork name', () => {
    const pdf = entry('a', 'pro', '可拆卸#BG00733#CHARACTERCIRCLE.pdf')
    expect(buildArtworkComparisons([pdf], [sheetRow('BG00733', 'BEARPALS')])[0]?.issue).toMatch(/名称冲突/)
  })
})
