import { useEffect, useState } from 'react'
import { PatternComparisonPanel } from './PatternComparisonPanel'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { WorkbookPreviewResult } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import { nextOccupiedColumn, findSeriesTargets, type ExistingSeriesSelection, type ExistingSeriesTarget, type HistoricalPatternOption } from './existing-series'

export function ExistingSeriesPicker({ selection, target, confirmed, onSelect, onTarget, onHistoricalPatterns, onConfirmedChange, analysis, onAnalysis }: {
  selection: ExistingSeriesSelection | null; target: ExistingSeriesTarget | null
  confirmed: boolean
  onSelect(value: ExistingSeriesSelection): void; onTarget(value: ExistingSeriesTarget | null): void
  onHistoricalPatterns(value: HistoricalPatternOption[]): void
  onConfirmedChange(value: boolean): void
  analysis: ImageAnalysisResult | null; onAnalysis(value: ImageAnalysisResult): void
}): React.JSX.Element {
  const [series, setSeries] = useState<ExistingSeriesSelection[]>([])
  const [targets, setTargets] = useState<ExistingSeriesTarget[]>([])
  const [pictures, setPictures] = useState<WorkbookPreviewResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let active = true
    void desktopApi.baseFiles.preview({ kind: 'barcodeReference', imageEndRow: 0 }).then(async first => {
      const sheetName = first.sheetNames.find(name => /系列名.*对应.*代码|系列.*代码/.test(name))
      if (!sheetName) throw new Error('A 条码参考未找到系列名对应代码分表')
      const data = await desktopApi.baseFiles.preview({ kind: 'barcodeReference', sheetName, imageEndRow: 0 })
      if (active) { const options = data.rows.flatMap(row => {
        const value = (col: string) => row.cells.find(c => c.address === `${col}${row.rowNumber}`)?.value.trim() ?? ''
        return /^[A-Z]\d+$/i.test(value('A')) && value('B') ? [{ code: value('A'), englishName: value('B'), chineseName: value('C'), referenceRow: row.rowNumber, referenceSheet: sheetName, referenceAppendColumn: nextOccupiedColumn(data, [row.rowNumber]) }] : []
      }); setSeries(options); const current = options.find(s => s.referenceRow === selection?.referenceRow); if (current && current.referenceAppendColumn !== selection?.referenceAppendColumn) onSelect(current) }
    }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!selection) return
    let active = true
    setBusy(true); setError(''); setPictures(null); onHistoricalPatterns([])
    void (async () => {
      const first = await desktopApi.baseFiles.preview({ kind: 'domesticNaming', imageEndRow: 0 })
      const found: ExistingSeriesTarget[] = []
      for (const sheetName of first.sheetNames) {
        if (!active) return
        const data = sheetName === first.activeSheetName ? first : await desktopApi.baseFiles.preview({ kind: 'domesticNaming', sheetName, imageEndRow: 0 })
        found.push(...findSeriesTargets(data, selection))
      }
      if (active) { setTargets(found); const current = found.find(t => t.sheet === target?.sheet && t.nameRow === target?.nameRow); if (current) onTarget(current); if (!found.length) setError('国内命名表未找到系列名与代码同时匹配的行，请先核对基础资料。') }
    })().catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [selection?.code, selection?.englishName])
  useEffect(() => {
    if (!target) { setPictures(null); onConfirmedChange(false); onHistoricalPatterns([]); return }
    let active = true
    setPictures(null); onHistoricalPatterns([])
    void desktopApi.baseFiles.preview({ kind: 'domesticNaming', sheetName: target.sheet, imageStartRow: target.nameRow - 1, imageEndRow: target.nameRow, imagesOnly: false })
      .then(data => { if (active) { setPictures(data); onHistoricalPatterns(historicalPatternOptions(data, target.nameRow)) } }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [target?.sheet, target?.nameRow])
  const historical = pictures && target ? historicalPatternOptions(pictures, target.nameRow) : []
  return <section className="panel existing-series-picker">
    <div className="existing-series-heading"><div><h3>选择已有系列</h3><p>浏览历史系列；在下方当前区域设置中看图选择对应名称。</p></div>{selection && <span>{selection.code} · {selection.chineseName}</span>}</div>
    <div className="series-selection-grid"><label className="field"><span>搜索系列名称 / 代码</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="输入代码或名称筛选" /></label>
    <label className="field"><span>A 条码参考中的系列</span><select value={selection?.referenceRow ?? ''} onChange={e => { const next = series.find(s => s.referenceRow === Number(e.target.value)); if (next) { onTarget(null); onSelect(next) } }}>
      <option value="">请选择系列</option>{series.filter(s => `${s.code} ${s.englishName} ${s.chineseName}`.toLowerCase().includes(query.toLowerCase()) || s.referenceRow === selection?.referenceRow).map(s => <option key={s.referenceRow} value={s.referenceRow}>{s.code} · {s.englishName} · {s.chineseName}</option>)}
    </select></label>
    {busy ? <p>正在查找国内命名表…</p> : <label className="field"><span>国内命名表中的位置</span><select value={target ? `${target.sheet}:${target.nameRow}` : ''} onChange={e => onTarget(targets.find(t => `${t.sheet}:${t.nameRow}` === e.target.value) ?? null)}><option value="">请选择追加位置</option>{targets.map(t => <option key={`${t.sheet}:${t.nameRow}`} value={`${t.sheet}:${t.nameRow}`}>{t.sheet} · 第 {t.nameRow} 行</option>)}</select></label>}
    </div>
    {error && <div className="alert warning">{error}</div>}
    {target && !confirmed && <div className="series-compare-board history-confirm-board">
      <section className="comparison-strip"><header><strong>确认历史系列 · {historical.length} 个图案</strong><span>确认后自动收起并开始 AI 对比</span></header>
        <div className="comparison-strip-scroll">{historical.map(item => <figure key={item.id}><img src={item.imageDataUrl} alt={item.name} loading="lazy" decoding="async" /><figcaption title={item.name}>{item.name}</figcaption></figure>)}
          {!historical.length && <p>{pictures ? '此系列没有可显示的历史图案。' : '正在载入历史图案…'}</p>}
        </div>
      </section>
      <div className="history-confirm-actions"><span>{target.sheet} · 第 {target.nameRow} 行</span><button className="primary-button" disabled={!historical.length} onClick={() => onConfirmedChange(true)}>确认使用此历史系列</button></div>
    </div>}
    {target && confirmed && <div className="confirmed-series-summary"><div><strong>{selection?.code} · {selection?.englishName}</strong><span>{target.sheet} 第 {target.nameRow} 行 · {historical.length} 个历史图案</span></div><button className="secondary-button" onClick={() => onConfirmedChange(false)}>重新查看历史图案</button></div>}
    {target && confirmed && <PatternComparisonPanel analysis={analysis} references={historical} onAnalysis={onAnalysis} autoStart />}
  </section>
}

function historicalPatternOptions(pictures: WorkbookPreviewResult, nameRow: number): HistoricalPatternOption[] {
  const names = pictures.rows.find(r => r.rowNumber === nameRow)?.cells ?? []
  return (pictures.rows.find(r => r.rowNumber === nameRow - 1)?.cells ?? []).flatMap(cell => {
    const name = names.find(n => n.address.replace(/\d/g, '') === cell.address.replace(/\d/g, ''))?.value.trim()
    return cell.generatedImageDataUrl && name && !/#\s*[A-Z]\d+\s*系列/i.test(name) && !/DISPIMG\s*\(/i.test(name)
      ? [{ id: cell.address, name, imageDataUrl: cell.generatedImageDataUrl }] : []
  })
}
