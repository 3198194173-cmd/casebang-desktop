import { useEffect, useMemo, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { BarcodeSource, LifecycleDraft, LifecycleDraftSummary } from '@shared/lifecycle-contracts'
import { patternVariantKey, previewMaterialCodes } from '@shared/material-coding'
import '../../styles/lifecycle.css'
import { useAccount, accountError } from '../../app/account-context'

export function MaterialLifecyclePage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [drafts, setDrafts] = useState<LifecycleDraftSummary[]>([])
  const [draft, setDraft] = useState<LifecycleDraft | null>(null)
  const [source, setSource] = useState<BarcodeSource | null>(null)
  const [variants, setVariants] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'material' | 'barcode'>('material')
  const [active, setActive] = useState('')
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const { account, busy: accountBusy, login } = useAccount()
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  useEffect(() => { if (enabled) void run(async () => setDrafts(await desktopApi.lifecycle.list())) }, [enabled])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
  const open = (value: LifecycleDraft): void => {
    setDraft(value); setSource(value.barcodeSource); setVariants(value.patternVariants)
    setActive(value.rows[0]?.id ?? ''); setPage(0); setDirty(false)
  }
  const canReplace = (): boolean => !dirty || window.confirm('当前准备资料尚未保存，是否放弃这些修改？')
  const results = useMemo(() => draft ? previewMaterialCodes({ rows: draft.rows, patternVariants: variants }) : [], [draft, variants])
  const indexed = useMemo(() => new Map(results.map(row => [row.rowId, row])), [results])
  const selected = draft?.rows.find(row => row.id === active)
  const selectedKey = selected ? patternVariantKey(selected.identity) : ''
  const loginAccount = async (): Promise<void> => {
    setError(''); setMessage('已打开钉钉登录页面，正在等待确认…')
    try { const value = await login('downstream'); setMessage(`已登录：${value.user?.displayName ?? '钉钉账号'}`) }
    catch (reason) { setError(accountError(reason, '钉钉登录失败')); setMessage('') }
  }
  return <div className="lifecycle-page">
    <header className="lc-intro"><div><small>下游业务</small><h2>新建表加工</h2><p>核对物料编码、选择 69 码来源，并为后续图档确认准备数据。该功能不在上游业务端显示。</p></div>
      <button disabled={busy} onClick={() => { if (canReplace()) void run(async () => { const value = await desktopApi.lifecycle.importWorkbook(); if (value) open(value); setDrafts(await desktopApi.lifecycle.list()) }) }}>{busy ? '处理中…' : '临时导入本机表'}</button></header>
    <div className="lc-notice"><span>{account?.status === 'signed-in' ? `当前账号：${account.user?.displayName ?? '已登录'}。WPS 在线工作簿接入前，暂保留本机导入用于编码规则联调。` : account?.status === 'offline' ? '账号信息已保留，当前仅可处理本机草稿。' : '请使用下游业务端登录。'}</span>{account?.status === 'signed-in' ? <strong>下游工具</strong> : <button disabled={accountBusy} onClick={() => void loginAccount()}>{accountBusy ? '等待确认…' : '钉钉登录'}</button>}</div>
    {error && <div role="alert" className="alert error">{error}</div>}
    {message && <div role="status" className="lc-message">{message}</div>}
    <div className="lc-layout"><aside className="lc-drafts"><h3>本机工作簿</h3><p>保存准备资料，保留导入快照。</p>{!drafts.length && <p>暂无工作簿，请先导入上游生成的新建表。</p>}
      {drafts.map(item => <button key={item.id} disabled={busy} className={draft?.id === item.id ? 'selected' : ''} onClick={() => { if (canReplace()) void run(async () => open(await desktopApi.lifecycle.get(item.id))) }}><strong>{item.title}</strong><small>{item.rowCount} 条物料 · 版本 {item.version}</small></button>)}
    </aside><section className="lc-workbench">
      <nav className="lc-tabs" aria-label="新建表加工步骤">{([['material', '检查物料码'], ['barcode', '选择 69 码来源']] as const).map(([id, title]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</button>)}</nav>
      {!draft ? <div className="lc-empty"><h3>选择一份新建表</h3><p>WPS 接入后将从共享工作簿记录直接打开；当前可临时导入本机表进行规则联调。</p></div>
      : <><div className="lc-task-heading"><div><h3>{draft.title}</h3><small>版本 {draft.version} · {dirty ? '有未保存修改' : '准备资料已保存到本机'}</small></div><button disabled={busy || !dirty} onClick={() => void run(async () => { const value = await desktopApi.lifecycle.save({ id: draft.id, expectedVersion: draft.version, barcodeSource: source, patternVariants: variants }); setDraft(value); setDirty(false); setDrafts(await desktopApi.lifecycle.list()); setMessage('准备资料已保存；尚未发号、写入 Excel 或发送给其他账号。') })}>保存准备资料</button></div>
        {!!draft.warnings.length && <details className="lc-warnings"><summary>导入提醒（{draft.warnings.length}）</summary>{draft.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
        {tab === 'barcode' ? <div className="lc-barcode"><h3>本任务新增 69 码的来源</h3><p>由处理人选择，不因含华为机型强制决定来源。已有号码原样保留。</p>
          <label><input type="radio" name="barcode-source" checked={source === 'internal_monthly'} onChange={() => { setSource('internal_monthly'); setDirty(true) }} />内部年月流水 <small>YYYYMM + 7 位流水；不等同于平台商品条码</small></label>
          <label><input type="radio" name="barcode-source" checked={source === 'platform'} onChange={() => { setSource('platform'); setDirty(true) }} />平台来源 <small>由使用人取得号码后逐行对应、核验</small></label>
          <p>已有号码 {draft.rows.filter(row => row.barcode).length} 条 · 待填写 {draft.rows.filter(row => !row.barcode).length} 条</p><div className="lc-notice">当前仅保存来源选择。中央号码账本完成历史核对后，才开放正式发号。</div>
        </div> : <><div className="lc-summary">本地候选 {results.filter(row => row.status === 'candidate').length} · 已有编码 {results.filter(row => row.status === 'existing').length} · 待核实 {results.filter(row => row.status === 'blocked').length}<small>候选实时预检，不代表中央账本已核准；类目和工作簿顺序保持不变。</small></div>
          <div className="lc-table-wrap"><table><thead><tr><th>原始位置</th><th>物料名称</th><th>69 码</th><th>物料编码 / 候选</th><th>核对结果</th></tr></thead><tbody>{draft.rows.slice(page * 40, (page + 1) * 40).map(row => { const result = indexed.get(row.id)!; return <tr key={row.id} className={row.id === active ? 'selected' : ''}><td><button onClick={() => setActive(row.id)}>{row.sheet}<br />第 {row.row} 行</button></td><td>{row.materialName || '待补充：名称缺失'}</td><td>{row.barcode || '待填写'}</td><td>{result.candidate || '暂不生成'}</td><td>{result.issues.join('；') || (result.status === 'existing' ? '已有编码，保留' : '候选，未正式分配')}</td></tr> })}</tbody></table></div>
          <div className="lc-pagination"><button disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(draft.rows.length / 40))}</span><button disabled={(page + 1) * 40 >= draft.rows.length} onClick={() => setPage(page + 1)}>下一页</button></div>
          {selected && <section className="lc-row-editor"><h3>所选物料 · {selected.sheet} / {selected.nameAddress}</h3><p>{selected.identity.category || '类别待核实'} · {selected.identity.series || '系列待核实'} · {selected.identity.modelName || '机型待核实'} · 机型码 {selected.identity.modelCode || '—'} · {selected.identity.frame === 'silver' ? '银框' : '普通款'}</p>
            <label>两位图案 / 款式标识（候选）<input maxLength={2} disabled={busy || !selected.identity.domain} value={variants[selectedKey] ?? ''} placeholder="例如 A0" onChange={event => { const value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); setVariants(previous => { const next = { ...previous }; if (value) next[selectedKey] = value; else delete next[selectedKey]; return next }); setDirty(true) }} /></label><p>同类别、同图案、同框型共享标识；不同机型使用各自末两位机型码。已有编码优先核对，不默认银框一律为 AC。</p>
          </section>}
        </>}
      </>}
    </section></div>
  </div>
}
