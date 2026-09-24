import { useEffect, useMemo, useRef, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { CollaborationWorkItem, DingTalkArtworkEntry, DingTalkArtworkTarget } from '@shared/contracts'
import type { SharedLifecycleAnalysis } from '@shared/lifecycle-contracts'
import { previewMaterialCodes } from '@shared/material-coding'
import { parseArtworkFilename } from '@shared/artwork-comparison'
import { buildArtworkComparisons, categoryFolders, isPdf, modelFolders, selectedPdfs } from '@shared/artwork-selection'
import type { ArtworkVisualResult } from '@shared/artwork-ai'
import { renderArtworkPdf } from './render-artwork-pdf'
import '../../styles/lifecycle.css'
import { useAccount, accountError } from '../../app/account-context'
import { LocalWorkbookEditPanel } from '../collaboration/LocalWorkbookEditPanel'

const currentMonthPrefix = (): string => {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

function artworkCategoryMatches(row: { sheet: string; barcodeName: string }, categoryName: string): boolean {
  const value = `${row.sheet} ${row.barcodeName}`.toLowerCase()
  if (categoryName === '可拆卸') return /可拆卸|磁吸背盖|手机背盖|背盖/.test(value)
  if (categoryName === '一体壳' || /出镜壳|出片壳|出彩壳/.test(categoryName)) return /一体壳|出镜壳|出片壳|出彩壳/.test(value)
  return value.includes(categoryName.toLowerCase())
}

type WorkflowLane = 'selection' | 'coding' | 'artwork'

async function fetchArtworkPage(workItemId: string, pdf: DingTalkArtworkEntry, scopeId: string): Promise<string> {
  const value = await desktopApi.collaboration.artworkPdf({ workItemId, dentryId: pdf.id, scopeId })
  return renderArtworkPdf(value.dataUrl)
}

export function MaterialLifecyclePage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [items, setItems] = useState<CollaborationWorkItem[]>([])
  const [selectedItem, setSelectedItem] = useState<CollaborationWorkItem | null>(null)
  const [analysis, setAnalysis] = useState<SharedLifecycleAnalysis | null>(null)
  const [monthPrefix, setMonthPrefix] = useState(currentMonthPrefix)
  const [variants, setVariants] = useState<Record<string, string>>({})
  const [patternOverrideEnabled, setPatternOverrideEnabled] = useState(false)
  const [patternOverrideReason, setPatternOverrideReason] = useState('')
  const [tab, setTab] = useState<'barcode' | 'material' | 'artwork'>('barcode')
  const [artworkSessionActive, setArtworkSessionActive] = useState(false)
  const [artworkDatasetKey, setArtworkDatasetKey] = useState(0)
  const [artworkTarget, setArtworkTarget] = useState<DingTalkArtworkTarget | null>(null)
  const [artworkTargetUrl, setArtworkTargetUrl] = useState('')
  const [artworkEntries, setArtworkEntries] = useState<DingTalkArtworkEntry[]>([])
  const [artworkCategoryId, setArtworkCategoryId] = useState('')
  const [artworkModelId, setArtworkModelId] = useState('')
  const [selectedMainPdfs, setSelectedMainPdfs] = useState<Record<string, string>>({})
  const [artworkPreviews, setArtworkPreviews] = useState<Record<string, string>>({})
  const [artworkPreviewErrors, setArtworkPreviewErrors] = useState<Record<string, string>>({})
  const [artworkPreviewLoading, setArtworkPreviewLoading] = useState<Record<string, boolean>>({})
  const [openComparisonKey, setOpenComparisonKey] = useState<string | null>(null)
  const [artworkAiResults, setArtworkAiResults] = useState<Record<string, ArtworkVisualResult | { error: string }>>({})
  const [artworkProgress, setArtworkProgress] = useState('')
  const artworkPreviewScopeId = useRef<string | null>(null)
  const artworkPreviewRequests = useRef(new Map<string, Promise<string>>())
  const [activeSheet, setActiveSheet] = useState('')
  const [openAfterSave, setOpenAfterSave] = useState(true)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [codingBusy, setCodingBusy] = useState(false)
  const [artworkBusy, setArtworkBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [codingError, setCodingError] = useState('')
  const [codingMessage, setCodingMessage] = useState('')
  const [artworkError, setArtworkError] = useState('')
  const [artworkMessage, setArtworkMessage] = useState('')
  const workflowBusyRef = useRef<Record<WorkflowLane, boolean>>({ selection: false, coding: false, artwork: false })
  const busy = selectionBusy || codingBusy || artworkBusy
  const { account, busy: accountBusy, login } = useAccount()
  const run = async (operation: () => Promise<void>, lane: WorkflowLane = 'selection'): Promise<void> => {
    if (workflowBusyRef.current[lane]) return
    workflowBusyRef.current[lane] = true
    const setLaneBusy = lane === 'coding' ? setCodingBusy : lane === 'artwork' ? setArtworkBusy : setSelectionBusy
    const setLaneError = lane === 'coding' ? setCodingError : lane === 'artwork' ? setArtworkError : setError
    const setLaneMessage = lane === 'coding' ? setCodingMessage : lane === 'artwork' ? setArtworkMessage : setMessage
    setLaneBusy(true); setLaneError(''); setLaneMessage('')
    try { await operation() } catch (reason) { setLaneError(reason instanceof Error ? reason.message : String(reason)) } finally {
      workflowBusyRef.current[lane] = false
      setLaneBusy(false)
    }
  }
  const refreshItems = async (): Promise<CollaborationWorkItem[]> => {
    const values = (await desktopApi.collaboration.workItems()).filter(item => !['COMPLETED', 'CANCELLED'].includes(item.state))
    setItems(values)
    return values
  }
  useEffect(() => {
    if (!enabled) return
    if (account?.status === 'signed-in') void run(async () => { await refreshItems() })
  }, [enabled, account?.status])

  const analyze = async (item: CollaborationWorkItem, prefix = monthPrefix, nextVariants: Record<string, string> = {}, preserveArtwork = false): Promise<void> => {
    const keepArtwork = preserveArtwork && selectedItem?.id === item.id
    const value = await desktopApi.lifecycle.analyzeShared({
      workItemId: item.id, title: item.title, sourceWorkflow: item.sourceWorkflow, version: item.version, revision: item.revision,
      monthPrefix: prefix, patternVariants: nextVariants
    })
    const target = keepArtwork ? null : await desktopApi.collaboration.artworkTarget({ workItemId: item.id })
    const entries = !keepArtwork && target ? await desktopApi.collaboration.searchArtworkEntries({ workItemId: item.id, limit: 1000 }) : []
    setSelectedItem(item); setAnalysis(value); setVariants(value.patternVariants); setPatternOverrideEnabled(false); setPatternOverrideReason(''); setActiveSheet(value.sheetNames[0] ?? '')
    if (!keepArtwork) {
      setArtworkDatasetKey(previous => previous + 1)
      setArtworkTarget(target); setArtworkTargetUrl(target?.folderUrl ?? '')
      setArtworkEntries(entries); setArtworkCategoryId(''); setArtworkModelId('')
    }
  }
  const materialResults = useMemo(() => analysis ? previewMaterialCodes({ rows: analysis.rows, patternVariants: variants, sourceWorkflow: analysis.sourceWorkflow }) : [], [analysis, variants])
  const resultIndex = useMemo(() => new Map(materialResults.map(result => [result.rowId, result])), [materialResults])
  const candidateCount = materialResults.filter(result => result.status === 'candidate').length
  const blockedCount = materialResults.filter(result => result.status === 'blocked').length
  const patternOverrideAllowed = selectedItem?.sourceWorkflow === 'new-series' || selectedItem?.sourceWorkflow === 'new-products'
  const hasPatternOverrides = Boolean(analysis && Object.entries(variants).some(([key, value]) => analysis.patternVariants[key] !== value))
  const overrideReady = !hasPatternOverrides || Boolean(patternOverrideReason.trim())
  const artworkCategories = useMemo(() => categoryFolders(artworkEntries), [artworkEntries])
  const selectedArtworkCategory = artworkCategories.find(entry => entry.id === artworkCategoryId) ?? null
  const selectedArtworkRows = useMemo(() => {
    if (!analysis) return []
    const imageRows = analysis.artworkRows.filter(row => row.sheet.normalize('NFKC').includes('图片'))
    const sourceRows = imageRows.length ? imageRows : analysis.artworkRows
    if (!selectedArtworkCategory) return sourceRows
    return sourceRows.filter(row => artworkCategoryMatches(row, selectedArtworkCategory.name))
  }, [analysis, selectedArtworkCategory])
  const artworkModels = useMemo(() => selectedArtworkCategory ? modelFolders(artworkEntries, selectedArtworkCategory) : [], [artworkEntries, selectedArtworkCategory])
  const selectedArtworkModel = artworkModels.find(entry => entry.id === artworkModelId) ?? null
  const artworkPdfEntries = useMemo(() => selectedPdfs(artworkEntries, selectedArtworkCategory, selectedArtworkModel), [artworkEntries, selectedArtworkCategory, selectedArtworkModel])
  const directArtworkPdfs = useMemo(() => selectedPdfs(artworkEntries, selectedArtworkCategory, null), [artworkEntries, selectedArtworkCategory])
  const indexedPdfCount = useMemo(() => artworkEntries.filter(isPdf).length, [artworkEntries])
  const artworkComparisons = useMemo(() => buildArtworkComparisons(artworkPdfEntries, selectedArtworkRows, selectedMainPdfs), [artworkPdfEntries, selectedArtworkRows, selectedMainPdfs])
  const openComparison = artworkComparisons.find(item => item.key === openComparisonKey)
  const artworkPreviewScope = `${selectedItem?.id ?? ''}:${artworkDatasetKey}:${artworkTarget?.folderUrl ?? ''}:${artworkCategoryId}:${artworkModelId}:${artworkPdfEntries.map(pdf => `${pdf.id}@${pdf.version ?? ''}`).join(',')}`
  const readArtworkPage = (workItemId: string, pdf: DingTalkArtworkEntry, scopeId: string): Promise<string> => {
    const key = `${scopeId}:${pdf.id}`
    const existing = artworkPreviewRequests.current.get(key)
    if (existing) return existing
    const operation = fetchArtworkPage(workItemId, pdf, scopeId).finally(() => {
      if (artworkPreviewRequests.current.get(key) === operation) artworkPreviewRequests.current.delete(key)
    })
    artworkPreviewRequests.current.set(key, operation)
    return operation
  }
  useEffect(() => { setSelectedMainPdfs({}); setArtworkPreviews({}); setArtworkPreviewErrors({}); setArtworkPreviewLoading({}); setOpenComparisonKey(null); setArtworkAiResults({}); setArtworkProgress('') }, [artworkPreviewScope])
  useEffect(() => {
    if (enabled && artworkSessionActive) return
    setArtworkPreviews({}); setArtworkPreviewErrors({}); setArtworkPreviewLoading({}); setOpenComparisonKey(null); setArtworkAiResults({}); setArtworkProgress('')
  }, [enabled, artworkSessionActive])
  useEffect(() => {
    if (enabled) return
    setArtworkSessionActive(false)
    setTab('barcode')
  }, [enabled])
  useEffect(() => {
    if (!enabled || !artworkSessionActive || !selectedItem || !artworkTarget || !artworkPdfEntries.length) return
    let cancelled = false
    const workItemId = selectedItem.id
    const scopeId = crypto.randomUUID()
    artworkPreviewScopeId.current = scopeId
    const pending = [...artworkPdfEntries]
    setArtworkPreviewLoading(Object.fromEntries(pending.map(pdf => [pdf.id, true])))
    const worker = async (): Promise<void> => {
      while (pending.length && !cancelled) {
        const pdf = pending.shift()!
        try {
          const image = await readArtworkPage(workItemId, pdf, scopeId)
          if (!cancelled) setArtworkPreviews(previous => ({ ...previous, [pdf.id]: image }))
        } catch (reason) {
          if (!cancelled) setArtworkPreviewErrors(previous => ({ ...previous, [pdf.id]: reason instanceof Error ? reason.message : String(reason) }))
        } finally {
          if (!cancelled) setArtworkPreviewLoading(previous => ({ ...previous, [pdf.id]: false }))
        }
      }
    }
    // Limit memory use and avoid concurrent multi-megabyte DingTalk downloads.
    void worker()
    return () => {
      cancelled = true
      if (artworkPreviewScopeId.current === scopeId) artworkPreviewScopeId.current = null
      for (const key of artworkPreviewRequests.current.keys()) if (key.startsWith(`${scopeId}:`)) artworkPreviewRequests.current.delete(key)
      void desktopApi.collaboration.cancelArtworkPdf({ scopeId }).catch(() => undefined)
    }
  }, [artworkPreviewScope, enabled, artworkSessionActive])

  const endArtworkVerification = (): void => {
    const scopeId = artworkPreviewScopeId.current
    artworkPreviewScopeId.current = null
    if (scopeId) void desktopApi.collaboration.cancelArtworkPdf({ scopeId }).catch(() => undefined)
    setArtworkSessionActive(false)
    setTab('barcode')
  }

  const loginAccount = async (): Promise<void> => {
    setError(''); setMessage('已打开钉钉登录页面，正在等待确认…')
    try { const value = await login('downstream'); setMessage(`已登录：${value.user?.displayName ?? '钉钉账号'}`) }
    catch (reason) { setError(accountError(reason, '钉钉登录失败')); setMessage('') }
  }
  const saveAllocation = async (fillBarcodes: boolean, fillMaterialCodes: boolean): Promise<void> => {
    if (!selectedItem || !analysis) return
    const labels = [fillBarcodes ? '69 码' : '', fillMaterialCodes ? '物料编码' : ''].filter(Boolean).join('和')
    if (!window.confirm(`将把${labels}写入共享工作簿并保存为新的中央版本。已有值不会覆盖。是否继续？`)) return
    const result = await desktopApi.lifecycle.applyShared({
      workItemId: selectedItem.id, title: selectedItem.title,
      sourceWorkflow: selectedItem.sourceWorkflow,
      expectedVersion: selectedItem.version, expectedRevision: selectedItem.revision,
      monthPrefix, fillBarcodes, fillMaterialCodes, patternVariants: variants,
      patternOverrideEnabled,
      patternOverrideReason: patternOverrideReason.trim() || undefined
    })
    let openNote = ''
    if (openAfterSave) {
      try {
        const existing = await desktopApi.collaboration.activeLocalEdit({ workItemId: result.item.id })
        if (existing) {
          openNote = existing.hasChanges
            ? `；另有未提交的本地稿，未自动替换，请先在工作簿记录中处理：${existing.filePath}`
            : '；已有本地检查稿，请先关闭文档并结束旧会话，再下载加工后的中央修订'
        } else {
          await desktopApi.collaboration.beginLocalEdit({ workItemId: result.item.id, forceNew: true })
          openNote = '；已打开加工后的中央修订供本地表格软件检查，修改后请提交'
        }
      } catch (cause) {
        openNote = `；中央已保存，但打开本地编辑稿失败：${accountError(cause, '请稍后从工作簿记录重试')}`
      }
    }
    setCodingMessage(`已保存中央版本 ${result.item.revision}：填写 69 码 ${result.barcodeFilled} 条，物料编码 ${result.materialCodeFilled} 条${openNote}。`)
    const values = await refreshItems()
    const updated = values.find(item => item.id === result.item.id) ?? result.item
    await analyze(updated, monthPrefix, {}, true)
  }
  const bindArtworkTarget = async (): Promise<void> => {
    if (!selectedItem) return
    const target = await desktopApi.collaboration.bindArtworkTarget({ workItemId: selectedItem.id, folderUrl: artworkTargetUrl.trim() })
    setArtworkTarget(target)
    setArtworkEntries(await desktopApi.collaboration.searchArtworkEntries({ workItemId: selectedItem.id, limit: 1000 }))
    setArtworkCategoryId(''); setArtworkModelId('')
    setArtworkMessage(`当前工作簿已选择系列图档目录“${target.folderName}”。`)
  }
  const saveArtworkSelection = async (): Promise<void> => {
    if (!selectedItem || !artworkTarget || !artworkCategoryId || (!artworkModelId && !directArtworkPdfs.length)) return
    const target = await desktopApi.collaboration.bindArtworkTarget({ workItemId: selectedItem.id, folderUrl: artworkTarget.folderUrl, categoryDentryId: artworkCategoryId, ...(artworkModelId ? { modelDentryId: artworkModelId } : {}) })
    setArtworkTarget(target)
    setArtworkMessage(`已保存图档选择：${selectedArtworkCategory?.name ?? '类别'} / ${selectedArtworkModel?.name ?? '直接文件'}。`)
  }
  const loadArtworkPreview = async (pdf: DingTalkArtworkEntry): Promise<string> => {
    if (!selectedItem) throw new Error('请先选择共享工作簿')
    const scopeId = artworkPreviewScopeId.current
    if (!scopeId) throw new Error('请先进入印刷图档核验步骤。')
    setArtworkPreviewLoading(previous => ({ ...previous, [pdf.id]: true }))
    try {
      const image = await readArtworkPage(selectedItem.id, pdf, scopeId)
      if (artworkPreviewScopeId.current === scopeId) {
        setArtworkPreviews(previous => ({ ...previous, [pdf.id]: image }))
        setArtworkPreviewErrors(previous => { const next = { ...previous }; delete next[pdf.id]; return next })
      }
      return image
    } catch (reason) {
      if (artworkPreviewScopeId.current === scopeId) setArtworkPreviewErrors(previous => ({ ...previous, [pdf.id]: reason instanceof Error ? reason.message : String(reason) }))
      throw reason
    } finally { if (artworkPreviewScopeId.current === scopeId) setArtworkPreviewLoading(previous => ({ ...previous, [pdf.id]: false })) }
  }
  const compareArtworkItem = async (item: (typeof artworkComparisons)[number]): Promise<void> => {
    if (item.issue || !item.row?.imageDataUrl) throw new Error(item.issue ?? '共享表截图缺失')
    const scopeId = artworkPreviewScopeId.current
    if (!scopeId) throw new Error('印刷图档核验已结束。')
    const pdfImage = artworkPreviews[item.pdf.id] ?? await loadArtworkPreview(item.pdf)
    const result = await desktopApi.ai.compareArtworkImages({ pdfImageDataUrl: pdfImage, workbookImageDataUrl: item.row.imageDataUrl })
    if (artworkPreviewScopeId.current === scopeId) setArtworkAiResults(previous => ({ ...previous, [item.key]: result }))
  }
  const compareAllArtwork = async (): Promise<void> => {
    const eligible = artworkComparisons.filter(item => !item.issue && item.row?.imageDataUrl)
    if (!eligible.length) throw new Error('当前没有可自动核验的行；请先解决缺图、名称冲突或重复 PDF。')
    const scopeId = artworkPreviewScopeId.current
    if (!scopeId) throw new Error('印刷图档核验已结束。')
    setArtworkAiResults({})
    let completed = 0
    for (const item of eligible) {
      if (artworkPreviewScopeId.current !== scopeId) break
      setArtworkProgress(`${completed} / ${eligible.length}`)
      try {
        await compareArtworkItem(item)
      } catch (reason) {
        if (artworkPreviewScopeId.current === scopeId) setArtworkAiResults(previous => ({ ...previous, [item.key]: { error: reason instanceof Error ? reason.message : String(reason) } }))
      }
      completed += 1
    }
    if (artworkPreviewScopeId.current !== scopeId) return
    setArtworkProgress(`${completed} / ${eligible.length}`)
    setArtworkMessage(`AI 核验已处理 ${completed} 行；请查看每行视觉结论，异常行可打开 PDF 人工检查。`)
  }
  const sheetNames = useMemo(() => analysis ? [...new Set([...analysis.sheetNames, ...analysis.rows.map(row => row.sheet)])] : [], [analysis])
  const visibleRows = useMemo(() => {
    if (!analysis) return []
    const sheet = activeSheet || sheetNames[0]
    return sheet ? analysis.rows.filter(row => row.sheet === sheet) : analysis.rows
  }, [analysis, activeSheet, sheetNames])

  return <div className="lifecycle-page">
    <header className="lc-intro"><div><small>下游业务</small><h2>共享工作表加工</h2><p>编码处理与印刷图档核验相互独立，可以同时进行；切换页面会保留各自进度。</p></div>
      <button disabled={busy || account?.status !== 'signed-in'} onClick={() => void run(async () => { await refreshItems(); setMessage('共享工作簿列表已刷新。') })}>{busy ? '处理中…' : '刷新共享工作簿'}</button></header>
    <div className="lc-notice"><span>{account?.status === 'signed-in' ? `当前账号：${account.user?.displayName ?? '已登录'}。上游和下游账号都可填写并保存，修订记录会保存编辑人和时间。` : '请先登录；同一账号退出后可重新选择上游或下游工具。'}</span>{account?.status === 'signed-in' ? <strong>下游工具</strong> : <button disabled={accountBusy} onClick={() => void loginAccount()}>{accountBusy ? '等待确认…' : '钉钉登录'}</button>}</div>
    {error && <div role="alert" className="alert error">{error}</div>}
    {message && <div role="status" className="lc-message">{message}</div>}
    {codingError && <div role="alert" className="alert error">编码处理：{codingError}</div>}
    {codingMessage && <div role="status" className="lc-message">编码处理：{codingMessage}</div>}
    {artworkError && <div role="alert" className="alert error">图档核验：{artworkError}</div>}
    {artworkMessage && <div role="status" className="lc-message">图档核验：{artworkMessage}</div>}
    <div className="lc-layout"><div className="lc-workbook-picker"><label htmlFor="lc-workbook-select"><span className="lc-step-label">步骤 1 · 选择共享工作簿</span><select id="lc-workbook-select" disabled={busy || !items.length} value={selectedItem?.id ?? ''} onChange={event => { const item = items.find(candidate => candidate.id === event.target.value); if (item) void run(async () => analyze(item, monthPrefix, {})) }}><option value="">{items.length ? '请选择中央最新版本的工作簿' : '暂无共享工作簿'}</option>{items.map(item => <option key={item.id} value={item.id}>{item.title} · 版本 {item.revision}</option>)}</select></label><div className="lc-workbook-meta">{selectedItem ? <><strong title={selectedItem.title}>{selectedItem.title}</strong><small>中央版本 {selectedItem.revision} · {selectedItem.lastEditor.displayName} · {new Date(selectedItem.lastEditedAt).toLocaleString()}</small></> : <span>选定工作簿后开始编码或图档核验</span>}</div></div><section className="lc-workbench">
      {!analysis || !selectedItem ? <div className="lc-empty"><h3>选择一份共享工作簿</h3><p>软件会下载中央最新版本进行计算；只有点击保存后才建立新修订，不会覆盖历史版本。</p></div>
      : <><div className="lc-task-heading"><div><h3>{analysis.title}</h3><small>中央版本 {analysis.revision} · 共 {analysis.rows.length} 条物料</small></div></div>
        <LocalWorkbookEditPanel key={`${selectedItem.id}-${selectedItem.revision}`} workItemId={selectedItem.id} currentRevision={selectedItem.revision} onSaved={async item => { const values = await refreshItems(); await analyze(values.find(value => value.id === item.id) ?? item, monthPrefix, {}, true) }} />
        <section className="lc-choice"><div><span className="lc-step-label">独立加工流程</span><h3>{tab === 'artwork' ? '核验本系列印刷图档' : '编码处理'}</h3><p>{tab === 'artwork' ? '按图片工作表的图案名称和截图核验 PDF；切到编码处理也不会中断下载或清除核验结果。' : '69 码、物料编码与印刷图档核验可同时进行；切换流程会保留各自进度。'}</p></div><nav className="lc-tabs" aria-label="加工流程"><button aria-pressed={tab !== 'artwork'} onClick={() => setTab('barcode')}>2. 编码处理{codingBusy ? ' · 处理中' : ''}</button><button aria-pressed={tab === 'artwork'} onClick={() => { setArtworkSessionActive(true); setTab('artwork') }}>3. 核验印刷图档{artworkBusy ? ' · 处理中' : ''}</button></nav></section>
        {tab !== 'artwork' && <nav className="lc-subtabs" aria-label="编码子步骤"><button aria-pressed={tab === 'barcode'} onClick={() => setTab('barcode')}>69 码</button><button aria-pressed={tab === 'material'} onClick={() => setTab('material')}>物料编码</button></nav>}
        <section className="lc-stage"><span className="lc-step-label">{tab === 'artwork' ? '步骤 3' : '步骤 2'}</span><h3>{tab === 'barcode' ? '确认 69 码' : tab === 'material' ? '确认物料编码' : '选择并核验本系列印刷图档'}</h3></section>
        {tab === 'barcode' ? <><section className="lc-allocation-controls"><div><label>69 码年月前缀<input value={monthPrefix} maxLength={6} inputMode="numeric" onChange={event => setMonthPrefix(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label><small>默认取当前年月；遇到上月设计图档可改回上月，例如 202609。</small></div>
          <button disabled={selectionBusy || codingBusy || !/^\d{6}$/.test(monthPrefix)} onClick={() => void run(async () => analyze(selectedItem, monthPrefix, {}, true), 'coding')}>重新计算起始号</button></section><div className="lc-number-card"><div><small>选定前缀</small><strong>{analysis.barcodePlan.monthPrefix}</strong></div><div><small>总表最后已用</small><strong>{analysis.barcodePlan.previousCode ?? '该年月尚无号码'}</strong></div><div><small>本次第一个号码</small><strong>{analysis.barcodePlan.nextCode}</strong></div><div><small>待填写</small><strong>{analysis.barcodePlan.pendingCount} 条</strong></div></div>
          <p>系统只扫描中央总表“{analysis.barcodePlan.masterFileName}”中该年月的最大流水；未合并的共享工作簿不会改变基底。并行加工多份工作簿可能预览相同号码，请先合并一份并更新中央总表，再处理下一份。</p>
          <div className="lc-save-actions"><label><input type="checkbox" checked={openAfterSave} onChange={event => setOpenAfterSave(event.target.checked)} />保存中央修订后打开本地表格检查</label><button disabled={selectionBusy || codingBusy || !analysis.barcodePlan.pendingCount} onClick={() => void run(async () => saveAllocation(true, false), 'coding')}>填写 69 码并保存</button><button disabled={selectionBusy || codingBusy || !analysis.barcodePlan.pendingCount || !candidateCount} onClick={() => void run(async () => saveAllocation(true, true), 'coding')}>两项一起填写并保存</button></div>
        </> : tab === 'material' ? <><div className="lc-pattern-heading"><div><strong>图案编码识别结果</strong><small>系统已先完成图案分组、历史映射和占用检查。示例统一使用 iPhone 13 Pro，机型码为 53；保存时会替换为各行实际机型码。</small></div>
          {patternOverrideAllowed
            ? <button className={patternOverrideEnabled ? 'active' : ''} onClick={() => { if (patternOverrideEnabled) setVariants(analysis.patternVariants); setPatternOverrideEnabled(value => !value); setPatternOverrideReason('') }}>{patternOverrideEnabled ? '关闭自定义并恢复识别值' : '开启自定义图案标识'}</button>
            : <span className="lc-locked-note">{selectedItem.sourceWorkflow === 'new-models' ? '产品补机型：图案标识已锁定，仅替换末两位机型码' : '此来源不开放图案标识自定义'}</span>}
        </div>
          {patternOverrideEnabled && <div className="lc-override-reason"><label>自定义原因<textarea value={patternOverrideReason} maxLength={500} placeholder="说明为什么要调整自动识别出的图案标识；保存记录会保留此原因。" onChange={event => setPatternOverrideReason(event.target.value)} /></label><small>{hasPatternOverrides ? '已修改自动识别值，保存前必须填写原因。' : '尚未修改任何自动识别值。'}</small></div>}
          <div className="lc-pattern-grid">{analysis.patternPlans.map(plan => {
            const current = variants[plan.key] ?? plan.variant ?? ''
            const customized = current !== (plan.detectedVariant ?? '')
            const preview = current && plan.referenceCode ? plan.referenceCode.replace(/\.(?:[A-Z0-9]{2}|__)53$/, `.${current}53`) : null
            const restore = (): void => setVariants(previous => {
              const next = { ...previous }
              if (plan.detectedVariant) next[plan.key] = plan.detectedVariant
              else delete next[plan.key]
              return next
            })
            return <article key={plan.key} className={plan.issues.length ? 'warning' : ''}><div><strong>{plan.patternName || '图案名称待核实'}</strong><span>{plan.productCode || '无产品图案号'} · {plan.frame === 'silver' ? '银框' : '普通款'} · {plan.rowCount} 行</span></div><label>最终两位图案标识<input disabled={!patternOverrideEnabled || !patternOverrideAllowed} maxLength={2} value={current} placeholder="例如 A0" onChange={event => { const value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2); setVariants(previous => { const next = { ...previous }; if (value) next[plan.key] = value; else delete next[plan.key]; return next }) }} /></label><div className="lc-reference-code"><small>iPhone 13 Pro 预览</small><code>{preview ?? '确认标识后生成'}</code></div><small>自动识别：{plan.detectedVariant ?? '未识别'} · 最终采用：{current || '待确认'} · {customized ? '已自定义' : '未自定义'}{plan.source === 'master' ? ' · 历史复用' : plan.source === 'proposed' ? ' · 新图案候选' : ''}</small>{patternOverrideEnabled && customized && <button className="lc-restore" onClick={restore}>恢复自动值</button>}{Boolean(plan.issues.length || plan.warnings.length) && <small className="lc-plan-issues">{[...plan.issues, ...plan.warnings].join('；')}</small>}</article>
          })}</div>
          <div className="lc-summary">可填写 {candidateCount} 条 · 已有编码 {materialResults.filter(row => row.status === 'existing').length} 条 · 待核实 {blockedCount} 条<small>物料编码和 69 码互不作为前置条件；已有值不会覆盖。修改两位标识后，下方逐行预览会立即更新。</small></div>
          <div className="lc-save-actions"><label><input type="checkbox" checked={openAfterSave} onChange={event => setOpenAfterSave(event.target.checked)} />保存中央修订后打开本地表格检查</label><button disabled={selectionBusy || codingBusy || !candidateCount || !overrideReady} onClick={() => void run(async () => saveAllocation(false, true), 'coding')}>填写物料编码并保存</button><button disabled={selectionBusy || codingBusy || !analysis.barcodePlan.pendingCount || !candidateCount || !overrideReady} onClick={() => void run(async () => saveAllocation(true, true), 'coding')}>两项一起填写并保存</button></div></> : <section className="lc-artwork-step">
            <form className="lc-artwork-target" onSubmit={event => { event.preventDefault(); void run(bindArtworkTarget, 'artwork') }}><label>当前工作簿系列印刷图档文件夹<input value={artworkTargetUrl} onChange={event => setArtworkTargetUrl(event.target.value)} placeholder="https://alidocs.dingtalk.com/i/desktop/folders/..." /></label><button disabled={selectionBusy || artworkBusy || !artworkTargetUrl.trim()}>{artworkTarget ? '重新读取系列目录' : '读取系列目录'}</button></form>
            <p className="lc-artwork-hint">每个系列使用自己的文件夹链接；读取后再选择产品类别和样本机型，不需要绑定固定父目录。</p>
            {artworkTarget ? <><div className="lc-artwork-selected"><div><small>当前系列目录</small><strong>{artworkTarget.folderName}</strong></div><a href={artworkTarget.folderUrl} target="_blank" rel="noreferrer">打开钉盘检查</a></div>
              <div className="lc-artwork-selectors">
                <label>产品类别<select disabled={selectionBusy || artworkBusy} value={artworkCategoryId} onChange={event => { setArtworkCategoryId(event.target.value); setArtworkModelId('') }}><option value="">请选择类别目录</option>{artworkCategories.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
                <label>样本机型（直接放 PDF 时不用选）<select disabled={selectionBusy || artworkBusy || !artworkCategoryId || (!artworkModels.length && !directArtworkPdfs.length)} value={artworkModelId} onChange={event => setArtworkModelId(event.target.value)}><option value="">{directArtworkPdfs.length ? '类别目录中的 PDF（无需机型）' : '请选择实际机型目录'}</option>{artworkModels.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
                <small>当前目录 {artworkPdfEntries.length} 份 PDF · 唯一图案 {artworkComparisons.length} 个 · 图片分表候选 {selectedArtworkRows.length} 行 · 系列索引 {indexedPdfCount} 份 PDF</small>
                <button disabled={selectionBusy || artworkBusy || !artworkCategoryId || (!artworkModelId && !directArtworkPdfs.length)} onClick={() => void run(saveArtworkSelection, 'artwork')}>保存当前目录选择</button>
              </div>
              <section className="lc-artwork-compare"><header><div><strong>PDF 与共享表图片横向核验</strong><small>按产品编码一行；点击任一图案可放大并排对比。切换到编码页不会清除核验结果；只有结束核验才释放临时预览。</small></div><div><span>{artworkComparisons.filter(item => !item.issue).length} / {artworkComparisons.length} 行可核验</span><button disabled={selectionBusy || artworkBusy || !artworkComparisons.some(item => !item.issue && item.row?.imageDataUrl)} onClick={() => void run(compareAllArtwork, 'artwork')}>{artworkBusy ? `核验中 ${artworkProgress}` : '一键 AI 对比核验'}</button><button disabled={artworkBusy} onClick={endArtworkVerification}>结束核验并清除预览</button></div></header>
                {artworkComparisons.length ? <div className="lc-artwork-compare-table"><table><thead><tr><th>PDF 图案</th><th>PDF 文件名</th><th>共享表截图</th><th>图片对应名称（大写）</th><th>产品编码 / 分表</th><th>AI 核验</th></tr></thead><tbody>{artworkComparisons.map(item => { const { pdf, row } = item; const parsed = parseArtworkFilename(pdf.name); const result = artworkAiResults[item.key]; return <tr key={item.key}>
                  <td>{artworkPreviews[pdf.id] ? <button className="lc-artwork-preview-button" title="放大并排对比 PDF 与共享表图案" onClick={() => setOpenComparisonKey(item.key)}><img className="lc-artwork-thumb" src={artworkPreviews[pdf.id]} alt={`${pdf.name} 第一页图案`} /></button> : <><div className="lc-artwork-no-image">{artworkPreviewLoading[pdf.id] ? '正在加载 PDF…' : artworkPreviewErrors[pdf.id] ? 'PDF 预览失败' : '待读取 PDF 页图'}</div>{artworkPreviewErrors[pdf.id] && <><small className="lc-artwork-preview-error" title={artworkPreviewErrors[pdf.id]}>{artworkPreviewErrors[pdf.id]}</small><button disabled={selectionBusy || artworkBusy || artworkPreviewLoading[pdf.id]} onClick={() => void run(async () => { await loadArtworkPreview(pdf) }, 'artwork')}>重试预览</button></>}</>}</td>
                  <td><strong>{pdf.name}</strong><small>{parsed.productCode ?? '未解析编码'} · {item.alternatives.length ? `另有 ${item.alternatives.length} 份同码 PDF` : '单份 PDF'}</small>{item.alternatives.length > 0 && <select aria-label={`${item.key} 选择主 PDF`} disabled={selectionBusy || artworkBusy} value={selectedMainPdfs[item.key] ?? ''} onChange={event => { setSelectedMainPdfs(previous => ({ ...previous, [item.key]: event.target.value })); setArtworkAiResults(previous => { const next = { ...previous }; delete next[item.key]; return next }) }}><option value="">请选择主 PDF</option>{[pdf, ...item.alternatives].map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select>}<a href={pdf.nodeUrl} target="_blank" rel="noreferrer">打开原 PDF</a>{item.alternatives.map(extra => <a key={extra.id} href={extra.nodeUrl} target="_blank" rel="noreferrer">候选：{extra.name}</a>)}</td>
                  <td>{row?.imageDataUrl ? <button className="lc-artwork-preview-button" title="放大并排对比 PDF 与共享表图案" onClick={() => setOpenComparisonKey(item.key)}><img className="lc-artwork-thumb" src={row.imageDataUrl} alt={row.patternNameUpper || row.patternName || '图片分表截图'} /></button> : <div className="lc-artwork-no-image">未读取到截图</div>}</td>
                  <td className="lc-artwork-pattern-name"><strong>{row?.patternNameUpper || row?.patternName || '未匹配'}</strong><small>{row ? `${row.sheet} · 第 ${row.row} 行` : '图片分表无对应编码'}</small></td>
                  <td className="lc-artwork-product"><strong>{parsed.productCode ?? '—'}</strong><small>{row?.barcodeName || '—'}</small></td>
                  <td className={item.issue || !result || 'error' in result ? 'missing' : result.status === 'matched' ? 'matched' : 'missing'}>{item.issue ?? (!result ? '待 AI 视觉核验' : 'error' in result ? `读取/AI 失败：${result.error}` : result.status === 'matched' ? 'AI 视觉一致（待人工确认）' : result.status === 'mismatched' ? 'AI 视觉不一致' : 'AI 不确定')}{result && !('error' in result) && <small>{result.reason} · {Math.round(result.confidence * 100)}% · {result.model}</small>}{!item.issue && result && ('error' in result || result.status === 'uncertain') && <button disabled={selectionBusy || artworkBusy} onClick={() => void run(async () => { await compareArtworkItem(item); setArtworkMessage(`已重新核验 ${item.key}。`) }, 'artwork')}>单行重试</button>}</td>
                </tr> })}</tbody></table></div> : <div className="lc-artwork-empty">选择实际包含 PDF 的类别或机型目录后显示横向对比。支架、充电宝等直接放 PDF 的类别无需机型。</div>}</section>
              <div className="lc-artwork-pending"><strong>核验规则</strong><p>AI 只比较实际 PDF 页图与共享表截图；权限错误、重名、缺图、名称冲突不会判为通过。AI 一致仍需人工确认。</p></div></> : <div className="lc-artwork-blocked"><strong>尚未读取本系列目录</strong><p>请粘贴当前系列的钉盘文件夹链接，按真实目录选择类别与可选机型。</p></div>}
          </section>}
        {!!analysis.warnings.length && <details className="lc-warnings"><summary>工作簿提醒（{analysis.warnings.length}）</summary>{analysis.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
        {tab !== 'artwork' && <section className="lc-sheet-view"><div className="lc-sheet-heading"><div><strong>共享表预览</strong><small>按工作表查看，完整显示当前分表内容；图片工作表由第 3 步用于印刷图档比对。</small></div><span>{visibleRows.length} 行</span></div><nav className="lc-sheet-tabs" aria-label="共享表工作表">{sheetNames.map(name => <button key={name} className={name === (activeSheet || sheetNames[0]) ? 'active' : ''} onClick={() => setActiveSheet(name)}>{name}</button>)}</nav><div className="lc-table-wrap"><table><thead><tr><th>行号</th><th>物料名称</th><th>69 码 / 本次预览</th><th>物料编码 / 候选</th><th>核对结果</th></tr></thead><tbody>{visibleRows.map(row => { const result = resultIndex.get(row.id)!; const eligible = row.materialName.trim() && !row.issues.some(issue => issue.includes('业务字段含公式')); const pendingBefore = analysis.rows.slice(0, analysis.rows.indexOf(row)).filter(item => !item.barcode.trim() && item.materialName.trim() && !item.issues.some(issue => issue.includes('业务字段含公式'))).length; const barcodePreview = row.barcode || (eligible ? `${monthPrefix}${String(Number(analysis.barcodePlan.nextCode.slice(6)) + pendingBefore).padStart(7, '0')}` : '需人工核实'); return <tr key={row.id}><td>{row.row}</td><td>{row.materialName || '待补充：名称缺失'}</td><td>{barcodePreview}</td><td>{result.candidate || '暂不生成'}</td><td>{result.issues.join('；') || (result.status === 'existing' ? '已有编码，保留' : '可以写入')}</td></tr> })}</tbody></table>{!visibleRows.length && <div className="lc-sheet-empty">这是图片工作表或辅助工作表，业务字段不在此表显示；第 3 步会读取其中的图案名称与截图。</div>}</div></section>}
      </>}
    </section></div>
    {openComparison && <div className="lc-artwork-preview-overlay" role="presentation" onClick={() => setOpenComparisonKey(null)} onKeyDown={event => { if (event.key === 'Escape') setOpenComparisonKey(null) }}>
      <div className="lc-artwork-preview-dialog lc-artwork-comparison-dialog" role="dialog" aria-modal="true" aria-label="PDF 与共享表图案放大对比" onClick={event => event.stopPropagation()}>
        <header><div><strong>{parseArtworkFilename(openComparison.pdf.name).productCode ?? '未解析编码'} · {openComparison.row?.patternNameUpper || openComparison.row?.patternName || '未匹配'}</strong><small>{openComparison.pdf.name}</small></div><button autoFocus onClick={() => setOpenComparisonKey(null)}>关闭对比</button></header>
        <div className="lc-artwork-comparison-images"><figure><figcaption>PDF 实际图案</figcaption>{artworkPreviews[openComparison.pdf.id] ? <img src={artworkPreviews[openComparison.pdf.id]} alt="PDF 第一页完整图案" /> : <p>PDF 图案尚未加载</p>}</figure><figure><figcaption>共享表截图 · {openComparison.row?.sheet || '未匹配分表'}</figcaption>{openComparison.row?.imageDataUrl ? <img src={openComparison.row.imageDataUrl} alt="共享表图片分表截图" /> : <p>共享表没有对应截图</p>}</figure></div>
      </div>
    </div>}
  </div>
}
