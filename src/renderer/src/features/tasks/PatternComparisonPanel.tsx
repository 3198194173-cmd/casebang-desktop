import { applyMaterial } from '@shared/material-recognition'
import { useEffect, useRef, useState } from 'react'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { ComparePatternsResult } from '@shared/pattern-comparison'
import { desktopApi } from '../../app/desktop-api'
import type { HistoricalPatternOption } from './existing-series'

export function PatternComparisonPanel({ analysis, references, onAnalysis, autoStart = false }: {
  analysis: ImageAnalysisResult | null; references: HistoricalPatternOption[]
  onAnalysis(value: ImageAnalysisResult): void
  autoStart?: boolean
}): React.JSX.Element {
  const products = analysis?.crops.filter(c => c.role !== 'series-overview') ?? []
  const stamp = JSON.stringify([analysis?.sourceImagePath, references.map(r => [r.id, r.name]), products.map(c => [c.id, c.x, c.y, c.width, c.height, c.patternGroupId])])
  const latest = useRef({ analysis, stamp }); latest.current = { analysis, stamp }
  const runId = useRef(0)
  const autoStamp = useRef('')
  const stop = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [materials, setMaterials] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, ComparePatternsResult>>({})
  useEffect(() => { runId.current++; setResults({}); setMaterials({}); setMessage(''); setBusy(false); return () => { runId.current++ } }, [stamp])
  const compare = async (): Promise<void> => {
    if (!analysis || busy) return
    const id = ++runId.current; stop.current = false; setBusy(true); setResults({}); setMaterials({})
    try {
      for (let i = 0; i < products.length; i++) {
        if (stop.current || id !== runId.current) break
        const crop = products[i]!
        setMessage(`正在比对 ${i + 1} / ${products.length}：${crop.label || crop.id}`)
        const input = { sourceImagePath: analysis.sourceImagePath, crop }
        const [comparison, material] = await Promise.allSettled([
          desktopApi.ai.comparePatterns({ ...input, references }),
          desktopApi.ai.recognizeMaterial(input)
        ])
        if (id !== runId.current || latest.current.stamp !== stamp || stop.current) break
        if (material.status === 'fulfilled' && latest.current.analysis) {
          const next = applyMaterial(latest.current.analysis, input, material.value)
          latest.current.analysis = next
          onAnalysis(next)
          setMaterials(current => ({ ...current, [crop.id]: `${material.value.material} · ${material.value.reason}` }))
        } else setMaterials(current => ({ ...current, [crop.id]: '材质识别失败，保留原值，请人工填写。' }))
        if (comparison.status === 'fulfilled') setResults(current => ({ ...current, [crop.id]: comparison.value }))
        else setMaterials(current => ({ ...current, [crop.id]: `${current[crop.id]}；图案比对失败，请重试。` }))
      }
      if (id === runId.current) setMessage(stop.current ? '已停止，已返回的结果仍可采用。' : '识别完成，请核对匹配建议和材质。')
    } catch (error) { if (id === runId.current) setMessage(`比对未全部完成：${error instanceof Error ? error.message : String(error)}。已完成的建议已保留。`) }
    finally { if (id === runId.current) setBusy(false) }
  }
  useEffect(() => {
    if (!autoStart || !analysis || !products.length || !references.length || references.length > 120 || autoStamp.current === stamp) return
    autoStamp.current = stamp
    const timer = window.setTimeout(() => { void compare() }, 80)
    return () => window.clearTimeout(timer)
  }, [autoStart, stamp, references.length, products.length])
  const apply = (cropId: string, result: ComparePatternsResult): void => {
    const current = latest.current.analysis
    if (!current || latest.current.stamp !== stamp || result.status !== 'matched' || !result.name) return
    // Only update the individually compared crop, never infer a group match.
    const next = { ...current, crops: current.crops.map(c => c.id === cropId ? { ...c, patternNameEn: result.name! } : c) }
    latest.current.analysis = next
    onAnalysis(next)
  }
  const completed = Object.keys(results).length
  return <section className="pattern-comparison-compact">
    <div className="pattern-comparison-action"><div><strong>AI 图案与材质</strong><small>{autoStart ? '确认历史系列后已自动执行；只保留核对结果。' : `${products.length} 张新增 · ${references.length} 张历史`}</small></div>
      <div><button className={autoStart ? 'secondary-button' : 'primary-button'} disabled={busy || !products.length || !references.length || references.length > 120} onClick={() => void compare()}>{busy ? `识别中 ${completed}/${products.length}` : autoStart ? '重新识别' : '开始识别'}</button>
      {busy && <button className="secondary-button" onClick={() => { stop.current = true; setMessage('正在停止…') }}>停止</button>}</div>
    </div>
    {!references.length && <small className="comparison-note">历史图片加载完成后可使用 AI 对比。</small>}
    {references.length > 120 && <small className="comparison-note">历史图案超过 120 张，请直接在当前区域设置中人工选择名称。</small>}
    {message && <div className="comparison-status">{message}</div>}
    {(products.some(c => results[c.id] || materials[c.id])) && <div className="comparison-result-chips">{products.map(crop => {
      const result = results[crop.id]
      if (!result && !materials[crop.id]) return null
      const material = materials[crop.id]?.split(' · ')[0]
      return <div className={`comparison-result-chip ${result?.status ?? 'pending'}`} key={crop.id}><div><strong>{crop.label || crop.id}</strong><span>{result?.status === 'matched' ? result.name : result ? '未确认同图' : '图案识别失败'}{material ? ` · ${material}` : ''}</span></div>{result?.status === 'matched' && <button disabled={crop.patternNameEn === result.name} onClick={() => apply(crop.id, result)}>{crop.patternNameEn === result.name ? '已采用' : '采用'}</button>}</div>
    })}</div>}
  </section>
}
