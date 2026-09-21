import { useEffect, useMemo, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { CollaborationWorkItem } from '@shared/contracts'
import type { SharedLifecycleAnalysis } from '@shared/lifecycle-contracts'
import { previewMaterialCodes } from '@shared/material-coding'
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
  const [patternOverrideEnabled, setPatternOverrideEnabled] = useState(false)
  const [patternOverrideReason, setPatternOverrideReason] = useState('')
  const [tab, setTab] = useState<'barcode' | 'material'>('barcode')
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
    const values = (await desktopApi.collaboration.workItems()).filter(item => !['COMPLETED', 'CANCELLED'].includes(item.state))
    setItems(values)
    return values
  }
  useEffect(() => {
    if (!enabled) return
    void desktopApi.supplement.getMaster().then(setMasterPath)
    if (account?.status === 'signed-in') void run(async () => { await refreshItems() })
  }, [enabled, account?.status])

  const analyze = async (item: CollaborationWorkItem, prefix = monthPrefix, nextVariants: Record<string, string> = {}): Promise<void> => {
    const value = await desktopApi.lifecycle.analyzeShared({
      workItemId: item.id, title: item.title, sourceWorkflow: item.sourceWorkflow, version: item.version, revision: item.revision,
      monthPrefix: prefix, patternVariants: nextVariants
    })
    setMasterPath(await desktopApi.supplement.getMaster())
    setSelectedItem(item); setAnalysis(value); setVariants(value.patternVariants); setPatternOverrideEnabled(false); setPatternOverrideReason(''); setPage(0)
  }
  const materialResults = useMemo(() => analysis ? previewMaterialCodes({ rows: analysis.rows, patternVariants: variants, sourceWorkflow: analysis.sourceWorkflow }) : [], [analysis, variants])
  const resultIndex = useMemo(() => new Map(materialResults.map(result => [result.rowId, result])), [materialResults])
  const candidateCount = materialResults.filter(result => result.status === 'candidate').length
  const blockedCount = materialResults.filter(result => result.status === 'blocked').length
  const patternOverrideAllowed = selectedItem?.sourceWorkflow === 'new-series' || selectedItem?.sourceWorkflow === 'new-products'
  const hasPatternOverrides = Boolean(analysis && Object.entries(variants).some(([key, value]) => analysis.patternVariants[key] !== value))
  const overrideReady = !hasPatternOverrides || Boolean(patternOverrideReason.trim())

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
      sourceWorkflow: selectedItem.sourceWorkflow,
      expectedVersion: selectedItem.version, expectedRevision: selectedItem.revision,
      monthPrefix, fillBarcodes, fillMaterialCodes, patternVariants: variants,
      patternOverrideEnabled,
      patternOverrideReason: patternOverrideReason.trim() || undefined,
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
    <div className="lc-layout"><aside className="lc-drafts"><span className="lc-step-label">步骤 1</span><h3>选择共享工作簿</h3><p>必须先选择中央最新版本，之后才能选择填写内容。</p>{!items.length && <p>暂无共享工作簿。</p>}
      {items.map(item => <button key={item.id} disabled={busy} className={selectedItem?.id === item.id ? 'selected' : ''} onClick={() => void run(async () => analyze(item, monthPrefix, {}))}><strong>{item.title}</strong><small>中央版本 {item.revision} · {item.lastEditor.displayName} {new Date(item.lastEditedAt).toLocaleString()}</small></button>)}
    </aside><section className="lc-workbench">
      {!analysis || !selectedItem ? <div className="lc-empty"><h3>选择一份共享工作簿</h3><p>软件会下载中央最新版本进行计算；只有点击保存后才建立新修订，不会覆盖历史版本。</p></div>
      : <><div className="lc-task-heading"><div><h3>{analysis.title}</h3><small>中央版本 {analysis.revision} · 共 {analysis.rows.length} 条物料</small></div><button disabled={busy} onClick={() => void run(async () => { await desktopApi.collaboration.openOnlineWorkbook({ workItemId: selectedItem.id }); setMessage('已打开 WPS 在线工作簿。') })}>打开 WPS 检查</button></div>
        <section className="lc-choice"><div><span className="lc-step-label">步骤 2</span><h3>选择填写内容</h3><p>69 码和物料编码可以分开保存，也可以在预览确认后一起保存。</p></div><nav className="lc-tabs" aria-label="编码步骤">{([['barcode', '填写 69 码'], ['material', '填写物料编码']] as const).map(([id, title]) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setPage(0) }}>{title}</button>)}</nav></section>
        <section className="lc-stage"><span className="lc-step-label">步骤 3</span><h3>{tab === 'barcode' ? '确认 69 码预览' : '确认每个图案的物料编码'}</h3></section>
        <section className="lc-master-source"><div><strong>物料总表</strong><span>{masterPath ?? '尚未选择'}</span><small>{tab === 'material' ? '用于复用已有图案标识并检查新标识占用。' : '用于查找所选年月最后一个已用号码。'}</small></div><button disabled={busy} onClick={() => void run(chooseMaster)}>选择 / 更换物料总表</button></section>
        {tab === 'barcode' ? <><section className="lc-allocation-controls"><div><label>69 码年月前缀<input value={monthPrefix} maxLength={6} inputMode="numeric" onChange={event => setMonthPrefix(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label><small>默认取当前年月；遇到上月设计图档可改回上月，例如 202609。</small></div>
          <button disabled={busy || !/^\d{6}$/.test(monthPrefix)} onClick={() => void run(async () => analyze(selectedItem, monthPrefix))}>重新计算起始号</button></section><div className="lc-number-card"><div><small>选定前缀</small><strong>{analysis.barcodePlan.monthPrefix}</strong></div><div><small>总表最后已用</small><strong>{analysis.barcodePlan.previousCode ?? '该年月尚无号码'}</strong></div><div><small>本次第一个号码</small><strong>{analysis.barcodePlan.nextCode}</strong></div><div><small>待填写</small><strong>{analysis.barcodePlan.pendingCount} 条</strong></div></div>
          <p>系统只扫描中央总表“{analysis.barcodePlan.masterFileName}”中该年月的最大流水；未合并的共享工作簿不会改变基底。并行加工多份工作簿可能预览相同号码，请先合并一份并更新中央总表，再处理下一份。</p>
          <div className="lc-save-actions"><label><input type="checkbox" checked={openAfterSave} onChange={event => setOpenAfterSave(event.target.checked)} />保存后自动打开 WPS 检查</label><button disabled={busy || !analysis.barcodePlan.pendingCount} onClick={() => void run(async () => saveAllocation(true, false))}>填写 69 码并保存</button><button disabled={busy || !analysis.barcodePlan.pendingCount || !candidateCount} onClick={() => void run(async () => saveAllocation(true, true))}>两项一起填写并保存</button></div>
        </> : <><div className="lc-pattern-heading"><div><strong>图案编码识别结果</strong><small>系统已先完成图案分组、历史映射和占用检查。示例统一使用 iPhone 13 Pro，机型码为 53；保存时会替换为各行实际机型码。</small></div>
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
          <div className="lc-save-actions"><label><input type="checkbox" checked={openAfterSave} onChange={event => setOpenAfterSave(event.target.checked)} />保存后自动打开 WPS 检查</label><button disabled={busy || !candidateCount || !overrideReady} onClick={() => void run(async () => saveAllocation(false, true))}>填写物料编码并保存</button><button disabled={busy || !analysis.barcodePlan.pendingCount || !candidateCount || !overrideReady} onClick={() => void run(async () => saveAllocation(true, true))}>两项一起填写并保存</button></div></>}
        {!!analysis.warnings.length && <details className="lc-warnings"><summary>工作簿提醒（{analysis.warnings.length}）</summary>{analysis.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
        <div className="lc-table-wrap"><table><thead><tr><th>原始位置</th><th>物料名称</th><th>69 码 / 本次预览</th><th>物料编码 / 候选</th><th>核对结果</th></tr></thead><tbody>{analysis.rows.slice(page * 40, (page + 1) * 40).map((row, offset) => { const result = resultIndex.get(row.id)!; const eligible = row.materialName.trim() && !row.issues.some(issue => issue.includes('业务字段含公式')); const pendingBefore = analysis.rows.slice(0, page * 40 + offset).filter(item => !item.barcode.trim() && item.materialName.trim() && !item.issues.some(issue => issue.includes('业务字段含公式'))).length; const barcodePreview = row.barcode || (eligible ? `${monthPrefix}${String(Number(analysis.barcodePlan.nextCode.slice(6)) + pendingBefore).padStart(7, '0')}` : '需人工核实'); return <tr key={row.id}><td>{row.sheet}<br />第 {row.row} 行</td><td>{row.materialName || '待补充：名称缺失'}</td><td>{barcodePreview}</td><td>{result.candidate || '暂不生成'}</td><td>{result.issues.join('；') || (result.status === 'existing' ? '已有编码，保留' : '可以写入')}</td></tr> })}</tbody></table></div>
        <div className="lc-pagination"><button disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(analysis.rows.length / 40))}</span><button disabled={(page + 1) * 40 >= analysis.rows.length} onClick={() => setPage(page + 1)}>下一页</button></div>
      </>}
    </section></div>
  </div>
}
