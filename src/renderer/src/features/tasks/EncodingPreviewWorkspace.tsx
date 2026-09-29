import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { EncodingPreviewResult, EncodingPreviewRow } from '@shared/coding-contracts'
import type { ImageAnalysisResult } from '@shared/image-contracts'
import type { CategoryFramePriceRule, TaskDraftInput } from '@shared/contracts'
import { ProductModelSelector } from './ProductModelSelector'
import type { ProductModelSettings, ProductModelType } from '@shared/product-model-settings'
import { desktopApi } from '../../app/desktop-api'
import { buildSeriesCodeReservePlan, isValidSeriesCode } from '@shared/series-code'
interface EncodingPreviewWorkspaceProps {
  existingSeriesCode?: string
  seriesNameZh: string
  seriesNameEn: string
  analysis: ImageAnalysisResult
  preview: EncodingPreviewResult | null
  setPreview: Dispatch<SetStateAction<EncodingPreviewResult | null>>
  form: TaskDraftInput
  onModelSettingsChange: (settings: ProductModelSettings, confirmed: ProductModelType[]) => void
  framePriceRules: Record<string, CategoryFramePriceRule>
  setFramePriceRules: (rules: Record<string, CategoryFramePriceRule>) => void
  setModelsConfirmed: (confirmed: boolean) => void
}

export function EncodingPreviewWorkspace({
  existingSeriesCode,
  seriesNameZh,
  seriesNameEn,
  analysis,
  preview,
  setPreview,
  form,
  onModelSettingsChange,
  framePriceRules,
  setFramePriceRules,
  setModelsConfirmed
}: EncodingPreviewWorkspaceProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const previewRequest = useRef(0)
  const loadPreview = async (): Promise<void> => {
    const requestId = ++previewRequest.current
    try {
      setBusy(true)
      setMessage(null)
      const result = await desktopApi.excel.buildEncodingPreview({
        seriesNameZh,
        seriesNameEn,
        crops: analysis.crops
          .filter((crop) => crop.role !== 'series-overview')
          .map((crop) => ({
            cropId: crop.id,
            productCategory: crop.productCategory,
            patternGroupId: crop.patternGroupId,
            patternNameEn: crop.patternNameEn
          }))
      })
      if (requestId !== previewRequest.current) return
      setPreview(existingSeriesCode ? { ...result, seriesCode: existingSeriesCode, recommendedSeriesCode: existingSeriesCode, seriesCodeWithSuffix: `${existingSeriesCode}系列`, seriesCodeStatus: 'existing', seriesCodeMessage: '已锁定选定系列；产品编码仍按类别新增。' } : result)
      setMessage(`已读取 A条码参考，共生成 ${result.rows.length} 条产品编码预览。`)
    } catch (reason) {
      if (requestId !== previewRequest.current) return
      setMessage(reason instanceof Error ? reason.message : '编码预览生成失败')
    } finally {
      if (requestId === previewRequest.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!preview && !busy) void loadPreview()
    return () => { previewRequest.current += 1 }
  }, [])

  const issues = useMemo(() => getEncodingPreviewIssues(preview), [preview])
  const rowsByCategory = useMemo(() => {
    const groups = new Map<string, EncodingPreviewRow[]>()
    for (const row of preview?.rows ?? []) {
      const rows = groups.get(row.productCategory) ?? []
      rows.push(row)
      groups.set(row.productCategory, rows)
    }
    return [...groups.entries()]
  }, [preview])
  const updateSeriesCode = (seriesCode: string): void => {
    const normalized = seriesCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    setPreview((current) => current ? {
      ...current,
      seriesCode: normalized,
      seriesCodeWithSuffix: `${normalized}系列`,
      seriesCodeReservePlan: buildSeriesCodeReservePlan(current.referencePreview?.seriesRows ?? [], normalized)
    } : current)
  }

  const updateProductCode = (cropId: string, productCode: string): void => {
    setPreview((current) => current ? {
      ...current,
      rows: current.rows.map((row) => row.cropId === cropId
        ? { ...row, productCode: productCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11) }
        : row)
    } : current)
  }

  if (!preview) {
    return (
      <div className="encoding-loading-state">
        <span>03</span>
        <h4>{busy ? '正在读取 A条码参考并计算编码…' : '尚未生成编码预览'}</h4>
        <p>程序只读取基础表，不会在此步骤修改原文件。</p>
        {message && <div className="alert warning">{message}</div>}
        {!busy && <button className="primary-button" onClick={() => void loadPreview()}>生成编码预览</button>}
      </div>
    )
  }

  return (
    <div className="encoding-preview-workspace">
      <div className="encoding-preview-toolbar">
        <div><strong>编码分配预览</strong><span>依据“A条码参考 → 系列名对应代码、已使用编码”实时计算；确认前不会写入任何表格。</span></div>
        <button className="secondary-button" disabled={busy} onClick={() => void loadPreview()}>{busy ? '正在重新计算…' : '重新读取并计算'}</button>
      </div>
      {message && <div className="alert info">{message}</div>}
      <div className="encoding-summary-grid">
        <section className={`encoding-series-card ${seriesCodeIssue(preview) ? 'error' : ''}`}>
          <span>系列编码</span>
          <div><input readOnly={Boolean(existingSeriesCode)} value={preview.seriesCode} onChange={(event) => updateSeriesCode(event.target.value)} /><b>系列</b></div>
          <strong>{preview.seriesCodeStatus === 'existing' ? '基础表已有系列' : '建议使用的新系列码'}</strong>
          <small>{preview.seriesCodeMessage}</small>
          <small>覆盖后保留 {preview.seriesCodeReservePlan.requiredReserveCount} 个可用系列码；本次将自动补充 {preview.seriesCodeReservePlan.supplementWrites.length > 0 ? preview.seriesCodeReservePlan.supplementWrites.map((item) => item.code).join('、') : '无需补充'}。</small>
          {seriesCodeIssue(preview) && <mark>{seriesCodeIssue(preview)}</mark>}
        </section>
        <section><span>产品记录</span><strong>{preview.rows.length}</strong><small>每张产品切片保留一条独立编码</small></section>
        <section><span>产品类别</span><strong>{rowsByCategory.length}</strong><small>按“已使用编码”的类别列分别分配</small></section>
        <section className={issues.length > 0 ? 'error' : 'ready'}><span>编码检查</span><strong>{issues.length > 0 ? `${issues.length} 项待处理` : '全部通过'}</strong><small>{issues.length > 0 ? '修正红色项目后才能进入生成步骤' : '未发现格式、占用或重复冲突'}</small></section>
      </div>
      {issues.length > 0 && <div className="alert warning">编码预览还有 {issues.length} 项问题。红色输入框会指出具体位置；修改后将即时重新检查。</div>}
      <ProductModelSelector analysis={analysis} form={form} onChange={onModelSettingsChange} framePriceRules={framePriceRules} onFramePriceRulesChange={setFramePriceRules} onConfirmedChange={setModelsConfirmed} />
      <div className="encoding-category-list">
        {rowsByCategory.map(([category, rows]) => (
          <section className="encoding-category-card" key={category}>
            <header>
              <div><strong>{category}</strong><span>{rows.length} 个产品 · 编码池 {rows[0]?.poolColumn ?? '未匹配'}列「{rows[0]?.poolHeader ?? '待人工确认'}」</span></div>
              <small>历史最新：{rows[0]?.previousLatestCode ?? '无记录'}</small>
            </header>
            <div className="encoding-row-list">
              {rows.map((row) => {
                const crop = analysis.crops.find((candidate) => candidate.id === row.cropId)
                const rowIssues = productCodeIssues(row, preview)
                return (
                  <article className={`encoding-row ${rowIssues.length > 0 ? 'error' : ''}`} key={row.cropId}>
                    {crop && <span className="encoding-thumb" style={{ ...cropThumbnailStyle(crop, analysis), aspectRatio: `${crop.width} / ${crop.height}` }} />}
                    <div className="encoding-row-name"><span>图案顺序 {String(row.order).padStart(2, '0')}</span><strong>{row.patternNameEn}</strong><small>{row.patternGroupId ? '同图案组产品，名称共享但编码独立' : '独立图案'}</small></div>
                    <div className="encoding-code-field"><label>产品编码</label><input value={row.productCode} onChange={(event) => updateProductCode(row.cropId, event.target.value)} /><small>{row.message}</small></div>
                    <div className="encoding-row-status">{rowIssues.length > 0 ? <mark>{rowIssues.join('；')}</mark> : <b>可使用</b>}</div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="encoding-rule-note">
        <strong>本次分配规则</strong>
        <span>同一产品类别按图片/图案顺序连续分配；磁吸支架背盖与磁吸气囊支架按图案组共用数字序号，但各自保留 ZJBG、ZJQN 前缀和独立产品记录。</span>
      </div>
    </div>
  )
}

export function getEncodingPreviewIssues(preview: EncodingPreviewResult | null): string[] {
  if (!preview) return ['尚未生成编码预览']
  const issues: string[] = []
  const seriesIssue = seriesCodeIssue(preview)
  if (seriesIssue) issues.push(seriesIssue)
  for (const row of preview.rows) issues.push(...productCodeIssues(row, preview).map((issue) => `${row.productCategory} / ${row.patternNameEn}：${issue}`))
  return issues
}

function seriesCodeIssue(preview: EncodingPreviewResult): string | null {
  if (!isValidSeriesCode(preview.seriesCode)) return '系列编码必须是一个大写字母加数字，例如 K1 或 A10。'
  const occupied = preview.usedSeriesCodes.includes(preview.seriesCode)
  if (occupied && !(preview.seriesCodeStatus === 'existing' && preview.seriesCode === preview.recommendedSeriesCode)) return '该系列编码已被其他系列使用。'
  return null
}

function productCodeIssues(row: EncodingPreviewRow, preview: EncodingPreviewResult): string[] {
  const issues: string[] = []
  if (row.status === 'unmapped') issues.push('产品类别未匹配编码池')
  if (!/^[A-Z]{2,6}\d{5}$/.test(row.productCode)) issues.push('格式应为字母前缀加 5 位数字')
  const historicalCodes = new Set(preview.pools.flatMap((pool) => pool.usedCodes))
  if (historicalCodes.has(row.productCode)) issues.push('该编码已存在于 A条码参考')
  if (row.productCode && preview.rows.some((candidate) => candidate.cropId !== row.cropId && candidate.productCode === row.productCode)) issues.push('与本次任务另一产品编码重复')
  return issues
}

function cropThumbnailStyle(crop: ImageAnalysisResult['crops'][number], analysis: ImageAnalysisResult): React.CSSProperties {
  const x = analysis.sourceWidth === crop.width ? 50 : crop.x / (analysis.sourceWidth - crop.width) * 100
  const y = analysis.sourceHeight === crop.height ? 50 : crop.y / (analysis.sourceHeight - crop.height) * 100
  return {
    backgroundImage: `url(${analysis.previewDataUrl})`,
    backgroundSize: `${analysis.sourceWidth / crop.width * 100}% ${analysis.sourceHeight / crop.height * 100}%`,
    backgroundPosition: `${x}% ${y}%`
  }
}
