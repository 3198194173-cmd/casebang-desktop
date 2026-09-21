import { useEffect, useMemo, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { CollaborationWorkItem } from '@shared/contracts'
import type { SharedLifecycleAnalysis } from '@shared/lifecycle-contracts'
import { patternVariantKey, previewMaterialCodes } from '@shared/material-coding'
import '../../styles/lifecycle.css'
import { useAccount, accountError } from '../../app/account-context'

const currentMonthPrefix = (): string => {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function MaterialLifecyclePage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [items, setItems] = useState<CollaborationWorkItem[]>([])
  const [selectedItem, setSelectedItem] = useState<CollaborationWorkItem | null>(null)
  const [analysis, setAnalysis] = useState<SharedLifecycleAnalysis | null>(null)
  const [monthPrefix, setMonthPrefix] = useState(currentMonthPrefix)
  const [variants, setVariants] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'barcode' | 'material'>('barcode')
  const [active, setActive] = useState('')
  const [page, setPage] = useState(0)
  const [masterPath, setMasterPath] = useState<string | null>(null)
  const [openAfterSave, setOpenAfterSave] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const { account, busy: accountBusy, login } = useAccount()
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const refreshItems = async (): Promise<CollaborationWorkItem[]> => {
    const values = await desktopApi.collaboration.workItems()
    setItems(values)
    return values
  }
  useEffect(() => {
    if (!enabled) return
    void desktopApi.supplement.getMaster().then(setMasterPath)
    if (account?.status === 'signed-in') void run(async () => { await refreshItems() })
  }, [enabled, account?.status])

  const analyze = async (item: CollaborationWorkItem, prefix = monthPrefix, nextVariants = variants): Promise<void> => {
    const value = await desktopApi.lifecycle.analyzeShared({
      workItemId: item.id, title: item.title, version: item.version, revision: item.revision,
      monthPrefix: prefix, patternVariants: nextVariants
    })
    setSelectedItem(item); setAnalysis(value); setActive(value.rows[0]?.id ?? ''); setPage(0)
  }
  const materialResults = useMemo(() => analysis ? previewMaterialCodes({ rows: analysis.rows, patternVariants: variants }) : [], [analysis, variants])
  const resultIndex = useMemo(() => new Map(materialResults.map(result => [result.rowId, result])), [materialResults])
  const selected = analysis?.rows.find(row => row.id === active)
  const selectedKey = selected ? patternVariantKey(selected.identity) : ''
  const candidateCount = materialResults.filter(result => result.status === 'candidate').length
  const blockedCount = materialResults.filter(result => result.status === 'blocked').length

  const loginAccount = async (): Promise<void> => {
    setError(''); setMessage('已打开钉钉登录页面，正在等待确认…')
    try { const value = await login('downstream'); setMessage(`已登录：${value.user?.displayName ?? '钉钉账号'}`) }
    catch (reason) { setError(accountError(reason, '钉钉登录失败')); setMessage('') }
  }
  const chooseMaster = async (): Promise<void> => {
    const value = await desktopApi.supplement.selectMaster()
    if (!value) return
    setMasterPath(value)
    if (selectedItem) await analyze(selectedItem)
  }
  const saveAllocation = async (fillBarcodes: boolean, fillMaterialCodes: boolean): Promise<void> => {
    if (!selectedItem || !analysis) return
    const labels = [fillBarcodes ? '69 码' : '', fillMaterialCodes ? '物料编码' : ''].filter(Boolean).join('和')
    if (!window.confirm(`将把${labels}写入共享工作簿并保存为新的中央版本。已有值不会覆盖。是否继续？`)) return
    const result = await desktopApi.lifecycle.applyShared({
      workItemId: selectedItem.id, title: selectedItem.title,
      expectedVersion: selectedItem.version, expectedRevision: selectedItem.revision,
      monthPrefix, fillBarcodes, fillMaterialCodes, patternVariants: variants,
      openOnlineAfterSave: openAfterSave
    })
    setMessage(`已保存中央版本 ${result.item.revision}：填写 69 码 ${result.barcodeFilled} 条，物料编码 ${result.materialCodeFilled} 条${result.openedOnline ? '；已打开 WPS 检查' : ''}。`)
    const values = await refreshItems()
    const updated = values.find(item => item.id === result.item.id) ?? result.item
    await analyze(updated)
  }

  return <div className="lifecycle-page">
    <header className="lc-intro"><div><small>下游业务</small><h2>共享工作表编码</h2><p>读取物料总表占用，按选定年月连续填写 69 码；物料编码可单独填写，也可与 69 码一起保存。</p></div>
      <button disabled={busy || account?.status !== 'signed-in'} onClick={() => void run(async () => { await refreshItems(); setMessage('共享工作簿列表已刷新。') })}>{busy ? '处理中…' : '刷新共享工作簿'}</button></header>
    <div className="lc-notice"><span>{account?.status === 'signed-in' ? `当前账号：${account.user?.displayName ?? '已登录'}。上游和下游账号都可填写并保存，修订记录会保存编辑人和时间。` : '请先登录；同一账号退出后可重新选择上游或下游工具。'}</span>{account?.status === 'signed-in' ? <strong>下游工具</strong> : <button disabled={accountBusy} onClick={() => void loginAccount()}>{accountBusy ? '等待确认…' : '钉钉登录'}</button>}</div>
    {error && <div role="alert" className="alert error">{error}</div>}
    {message && <div role="status" className="lc-message">{message}</div>}
    <div className="lc-layout"><aside className="lc-drafts"><h3>共享工作簿</h3><p>选择中央最新版本开始编码。</p>{!items.length && <p>暂无共享工作簿。</p>}
      {items.map(item => <button key={item.id} disabled={busy} className={selectedItem?.id === item.id ? 'selected' : ''} onClick={() => void run(async () => analyze(item))}><strong>{item.title}</strong><small>中央版本 {item.revision} · {item.lastEditor.displayName} {new Date(item.lastEditedAt).toLocaleString()}</small></button>)}
    </aside><section className="lc-workbench">
      <nav className="lc-tabs" aria-label="编码步骤">{([['barcode', '填写 69 码'], ['material', '填写物料编码']] as const).map(([id, title]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</button>)}</nav>
      {!analysis || !selectedItem ? <div className="lc-empty"><h3>选择一份共享工作簿</h3><p>软件会下载中央最新版本进行计算；只有点击保存后才建立新修订，不会覆盖历史版本。</p></div>
      : <><div className="lc-task-heading"><div><h3>{analysis.title}</h3><small>中央版本 {analysis.revision} · 共 {analysis.rows.length} 条物料</small></div><button disabled={busy} onClick={() => void run(async () => { await desktopApi.collaboration.openOnlineWorkbook({ workItemId: selectedItem.id }); setMessage('已打开 WPS 在线工作簿。') })}>打开 WPS 检查</button></div>
        <section className="lc-allocation-controls"><div><label>69 码年月前缀<input value={monthPrefix} maxLength={6} inputMode="numeric" onChange={event => setMonthPrefix(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label><small>默认取当前年月；遇到上月设计图档可改回上月，例如 202609。</small></div>
          <button disabled={busy || !/^\d{6}$/.test(monthPrefix)} onClick={() => void run(async () => analyze(selectedItem, monthPrefix))}>重新计算起始号</button></section>
        <section className="lc-master-source"><div><strong>物料总表</strong><span>{masterPath ?? '尚未选择'}</span></div><button disabled={busy} onClick={() => void run(chooseMaster)}>选择 / 更换物料总表</button></section>
        {tab === 'barcode' ? <><div className="lc-number-card"><div><small>选定前缀</small><strong>{analysis.barcodePlan.monthPrefix}</strong></div><div><small>总表最后已用</small><strong>{analysis.barcodePlan.previousCode ?? '该年月尚无号码'}</strong></div><div><small>本次第一个号码</small><strong>{analysis.barcodePlan.nextCode}</strong></div><div><small>待填写</small><strong>{analysis.barcodePlan.pendingCount} 条</strong></div></div>
          <p>系统扫描“{analysis.barcodePlan.masterFileName}”中该年月的最大流水；其他格式号码不会干扰。已有 69 码保留不变。</p>
          <div className="lc-save-actions"><label><input type="checkbox" checked={openAfterSave} onChange={event => setOpenAfterSave(event.target.checked)} />保存后自动打开 WPS 检查</label><button disabled={busy || !analysis.barcodePlan.pendingCount} onClick={() => void run(async () => saveAllocation(true, false))}>填写 69 码并保存</button><button disabled={busy || !analysis.barcodePlan.pendingCount || !candidateCount} onClick={() => void run(async () => saveAllocation(true, true))}>两项一起填写并保存</button></div>
        </> : <><div className="lc-summary">可填写 {candidateCount} 条 · 已有编码 {materialResults.filter(row => row.status === 'existing').length} 条 · 待核实 {blockedCount} 条<small>物料编码和 69 码互不作为前置条件；已有值不会覆盖。</small></div>
          <div className="lc-save-actions"><label><input type="checkbox" checked={openAfterSave} onChange={event => setOpenAfterSave(event.target.checked)} />保存后自动打开 WPS 检查</label><button disabled={busy || !candidateCount} onClick={() => void run(async () => saveAllocation(false, true))}>填写物料编码并保存</button><button disabled={busy || !analysis.barcodePlan.pendingCount || !candidateCount} onClick={() => void run(async () => saveAllocation(true, true))}>两项一起填写并保存</button></div></>}
        {!!analysis.warnings.length && <details className="lc-warnings"><summary>工作簿提醒（{analysis.warnings.length}）</summary>{analysis.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
        <div className="lc-table-wrap"><table><thead><tr><th>原始位置</th><th>物料名称</th><th>69 码 / 本次预览</th><th>物料编码 / 候选</th><th>核对结果</th></tr></thead><tbody>{analysis.rows.slice(page * 40, (page + 1) * 40).map((row, offset) => { const result = resultIndex.get(row.id)!; const eligible = row.materialName.trim() && !row.issues.some(issue => issue.includes('业务字段含公式')); const pendingBefore = analysis.rows.slice(0, page * 40 + offset).filter(item => !item.barcode.trim() && item.materialName.trim() && !item.issues.some(issue => issue.includes('业务字段含公式'))).length; const barcodePreview = row.barcode || (eligible ? `${monthPrefix}${String(Number(analysis.barcodePlan.nextCode.slice(6)) + pendingBefore).padStart(7, '0')}` : '需人工核实'); return <tr key={row.id} className={row.id === active ? 'selected' : ''}><td><button onClick={() => setActive(row.id)}>{row.sheet}<br />第 {row.row} 行</button></td><td>{row.materialName || '待补充：名称缺失'}</td><td>{barcodePreview}</td><td>{result.candidate || '暂不生成'}</td><td>{result.issues.join('；') || (result.status === 'existing' ? '已有编码，保留' : '可以写入')}</td></tr> })}</tbody></table></div>
        <div className="lc-pagination"><button disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(analysis.rows.length / 40))}</span><button disabled={(page + 1) * 40 >= analysis.rows.length} onClick={() => setPage(page + 1)}>下一页</button></div>
        {tab === 'material' && selected && <section className="lc-row-editor"><h3>所选物料 · {selected.sheet} / {selected.nameAddress}</h3><p>{selected.identity.category || '类别待核实'} · {selected.identity.series || '系列待核实'} · {selected.identity.modelName || '机型待核实'} · 机型码 {selected.identity.modelCode || '—'} · {selected.identity.frame === 'silver' ? '银框' : '普通款'}</p>
          <label>两位图案 / 款式标识<input maxLength={2} disabled={busy || !selected.identity.domain} value={variants[selectedKey] ?? ''} placeholder="例如 A0" onChange={event => { const value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); setVariants(previous => { const next = { ...previous }; if (value) next[selectedKey] = value; else delete next[selectedKey]; return next }) }} /></label><p>同类别、同图案、同框型共享标识；不同机型继续使用各自末两位机型码。</p>
        </section>}
      </>}
    </section></div>
  </div>
}
