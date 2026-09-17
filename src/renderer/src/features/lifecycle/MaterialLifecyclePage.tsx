import { useEffect, useMemo, useState } from 'react'
import { desktopApi } from '../../app/desktop-api'
import type { BarcodeSource, LifecycleDraft, LifecycleDraftSummary } from '@shared/lifecycle-contracts'
import { patternVariantKey, previewMaterialCodes } from '@shared/material-coding'
import '../../styles/lifecycle.css'
import { useAccount, accountError } from '../../app/account-context'
import type { CollaborationMember, CollaborationWorkItem } from '@shared/contracts'

export function MaterialLifecyclePage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [drafts, setDrafts] = useState<LifecycleDraftSummary[]>([])
  const [draft, setDraft] = useState<LifecycleDraft | null>(null)
  const [source, setSource] = useState<BarcodeSource | null>(null)
  const [variants, setVariants] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'material' | 'barcode' | 'handoff'>('material')
  const [active, setActive] = useState('')
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [members, setMembers] = useState<CollaborationMember[]>([])
  const [sentItems, setSentItems] = useState<CollaborationWorkItem[]>([])
  const [assigneeId, setAssigneeId] = useState('')
  const { account, busy: accountBusy, login } = useAccount()
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  useEffect(() => { if (enabled) void run(async () => setDrafts(await desktopApi.lifecycle.list())) }, [enabled])
  useEffect(() => {
    if (!enabled || account?.status !== 'signed-in') { setMembers([]); setSentItems([]); setAssigneeId(''); return }
    void Promise.all([desktopApi.collaboration.members(), desktopApi.collaboration.workItems('sent')])
      .then(([nextMembers, nextItems]) => { setMembers(nextMembers); setSentItems(nextItems); setAssigneeId(current => nextMembers.some(member => member.id === current) ? current : '') })
      .catch(reason => setError(accountError(reason, '协同成员读取失败')))
  }, [enabled, account?.status, account?.user?.id])
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
    try { const value = await login('upstream'); setMessage(`已登录：${value.user?.displayName ?? '钉钉账号'}`) }
    catch (reason) { setError(accountError(reason, '钉钉登录失败')); setMessage('') }
  }
  const submitHandoff = async (): Promise<void> => {
    if (!draft) { setError('请先导入要交接的新建工作簿。'); return }
    if (dirty) { setError('请先保存当前准备资料，再提交交接。'); return }
    if (!assigneeId) { setError('请选择接收人。'); return }
    const recipient = members.find(member => member.id === assigneeId)
    if (!recipient || !window.confirm(`确认将“${draft.title}”提交给 ${recipient.displayName}？\n提交后中央服务会保存工作簿快照和交接记录。`)) return
    await run(async () => {
      const result = await desktopApi.collaboration.submitLifecycle({ draftId: draft.id, expectedVersion: draft.version, assigneeId })
      setSentItems(await desktopApi.collaboration.workItems('sent'))
      setMessage(result.duplicate ? '该工作簿此前已提交，本次没有创建重复任务。' : `已提交给 ${result.item.assignee.displayName}，中央任务已建立。`)
    })
  }
  return <div className="lifecycle-page">
    <header className="lc-intro"><div><small>辅助入口 · 测试与历史补录</small><h2>导入旧工作簿</h2><p>仅用于双账号联调或补录既有文件；正常任务应由上游建表流程直接提交。</p></div>
      <button disabled={busy} onClick={() => { if (canReplace()) void run(async () => { const value = await desktopApi.lifecycle.importWorkbook(); if (value) open(value); setDrafts(await desktopApi.lifecycle.list()) }) }}>{busy ? '处理中…' : '选择工作簿'}</button></header>
    <div className="lc-notice"><span>{account?.status === 'signed-in' ? `当前账号：${account.user?.displayName ?? '已登录'}。此入口只用于旧表测试和补录。` : account?.status === 'offline' ? '账号信息已保留，但当前无法连接协同服务；本机草稿仍可继续编辑。' : '登录钉钉账号后才能把旧表提交给另一账号测试。'}</span>{account?.status === 'signed-in' ? <strong>账号已验证</strong> : <button disabled={accountBusy} onClick={() => void loginAccount()}>{accountBusy ? '等待确认…' : '钉钉登录'}</button>}</div>
    {error && <div role="alert" className="alert error">{error}</div>}
    {message && <div role="status" className="lc-message">{message}</div>}
    <div className="lc-layout"><aside className="lc-drafts"><h3>本机工作簿</h3><p>保存准备资料，保留导入快照。</p>{!drafts.length && <p>暂无工作簿，请先导入上游生成的新建表。</p>}
      {drafts.map(item => <button key={item.id} disabled={busy} className={draft?.id === item.id ? 'selected' : ''} onClick={() => { if (canReplace()) void run(async () => open(await desktopApi.lifecycle.get(item.id))) }}><strong>{item.title}</strong><small>{item.rowCount} 条物料 · 版本 {item.version}</small></button>)}
    </aside><section className="lc-workbench">
      <nav className="lc-tabs" aria-label="旧表测试步骤">{([['material', '检查物料码'], ['barcode', '选择69码来源'], ['handoff', '选择接收人']] as const).map(([id, title]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</button>)}</nav>
      {tab === 'handoff' ? <div className="lc-handoff">
        <div><span className="eyebrow">CROSS-COMPUTER HANDOFF</span><h3>提交给另一位企业账号</h3><p>只显示同企业且已经成功登录过 CASEBANG 软件的成员。提交会上传当前导入工作簿的只读快照，不会修改原文件。</p></div>
        {account?.status !== 'signed-in' ? <div className="lc-handoff-empty"><strong>需要登录企业账号</strong><button disabled={accountBusy} onClick={() => void loginAccount()}>钉钉登录</button></div>
          : !members.length ? <div className="lc-handoff-empty"><strong>暂无可选接收人</strong><span>请让第二个同企业账号先在另一台电脑登录一次；当前账号不会出现在自己的接收人列表中。</span></div>
          : <div className="lc-handoff-form"><label>接收人<select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">请选择已登录成员</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><button className="primary-button" disabled={busy || dirty || !draft || !assigneeId} onClick={() => void submitHandoff()}>{busy ? '正在提交…' : '确认提交交接'}</button></div>}
        <div className="lc-sent-items"><h4>我发出的任务</h4>{!sentItems.length ? <p>暂无中央交接任务。</p> : sentItems.slice(0, 10).map(item => <article key={item.id}><div><strong>{item.title}</strong><span>接收人：{item.assignee.displayName} · 修订 {item.revision}</span></div><mark>{handoffState(item.state)}</mark></article>)}</div>
      </div>
      : !draft ? <div className="lc-empty"><h3>导入一份新建表格</h3><p>支持按业务表头识别物料行；缺失或冲突记录会保留，不会静默跳过。</p></div>
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

function handoffState(state: string): string {
  const labels: Record<string, string> = { PENDING_PROCESSING: '等待接收', PROCESSING: '处理中', NEEDS_SOURCE_FIX: '待源头修正', PENDING_ORIGIN_REVIEW: '待我复核', COMPLETED: '已完成' }
  return labels[state] ?? state
}
