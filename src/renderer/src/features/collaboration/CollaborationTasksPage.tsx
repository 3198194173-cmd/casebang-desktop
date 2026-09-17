import { useEffect, useState } from 'react'
import type { CollaborationWorkItem } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import { accountError, useAccount } from '../../app/account-context'

export function CollaborationTasksPage({ enabled, onOpenLifecycle }: { enabled: boolean; onOpenLifecycle(): void }): React.JSX.Element {
  const { account, busy: accountBusy, login } = useAccount()
  const [box, setBox] = useState<'inbox' | 'sent'>('inbox')
  const [items, setItems] = useState<CollaborationWorkItem[]>([])
  const [busy, setBusy] = useState(false)
  const [activeItemId, setActiveItemId] = useState('')
  const [returningItemId, setReturningItemId] = useState('')
  const [returnReason, setReturnReason] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const load = async (nextBox = box): Promise<void> => {
    if (account?.status !== 'signed-in') { setItems([]); return }
    setBusy(true); setError('')
    try { setItems(await desktopApi.collaboration.workItems(nextBox)) }
    catch (reason) { setError(accountError(reason, '协同任务读取失败')) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (enabled) void load() }, [enabled, box, account?.status, account?.user?.id])
  const switchBox = (value: 'inbox' | 'sent'): void => { setBox(value); setItems([]) }
  const act = async (item: CollaborationWorkItem, action: 'claim' | 'return-source'): Promise<void> => {
    if (action === 'return-source' && !returnReason.trim()) { setError('请填写退回原因。'); return }
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.act({
        workItemId: item.id,
        action,
        expectedVersion: item.version,
        revision: item.revision,
        ...(action === 'return-source' ? { reason: returnReason.trim() } : {})
      })
      setItems(current => current.map(entry => entry.id === result.item.id ? result.item : entry))
      setReturningItemId(''); setReturnReason('')
      setMessage(action === 'claim' ? '任务已接收，现在可下载工作簿并开始处理。' : '任务已退回建表人，退回原因已记录。')
    } catch (reason) { setError(accountError(reason, '任务操作失败')) }
    finally { setActiveItemId('') }
  }
  const download = async (item: CollaborationWorkItem): Promise<void> => {
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.downloadWorkbook({ workItemId: item.id, title: item.title })
      if (!result.canceled) setMessage(`工作簿已保存：${result.path ?? ''}`)
    } catch (reason) { setError(accountError(reason, '工作簿下载失败')) }
    finally { setActiveItemId('') }
  }

  return <div className="collaboration-page">
    <header className="collaboration-hero"><div><span className="eyebrow">CASEBANG COLLABORATION</span><h2>协同任务</h2><p>账号属于整个软件；各业务流程完成后都从这里进入交接、处理和复核。</p></div><button className="secondary-button" onClick={onOpenLifecycle}>进入物料建档</button></header>
    {account?.status !== 'signed-in' ? <section className="collaboration-login"><div><strong>登录后查看企业任务</strong><p>使用钉钉企业身份隔离不同组织的数据和文件。</p></div><button className="primary-button" disabled={accountBusy} onClick={() => void login()}>{accountBusy ? '等待确认…' : '钉钉登录'}</button></section>
      : <><section className="collaboration-account-strip"><span className="status-dot" /><strong>{account.user?.displayName}</strong><span>企业账号已验证 · 所有业务流程共用</span></section>
        <nav className="collaboration-tabs"><button aria-pressed={box === 'inbox'} onClick={() => switchBox('inbox')}>待我处理</button><button aria-pressed={box === 'sent'} onClick={() => switchBox('sent')}>我发出的</button><button disabled={busy} onClick={() => void load()}>{busy ? '刷新中…' : '刷新'}</button></nav>
        {error && <div className="alert error">{error}</div>}
        {message && <div className="alert success">{message}</div>}
        <section className="collaboration-list">{!busy && !items.length ? <div className="collaboration-empty"><strong>{box === 'inbox' ? '暂无待处理任务' : '还没有发出任务'}</strong><p>{box === 'inbox' ? '其他已登录企业成员提交给你的任务会显示在这里。' : '可在“物料建档 → 提交交接”中选择接收人。'}</p></div> : items.map(item => <article key={item.id} className="collaboration-task-card">
          <div className="collaboration-state">{stateLabel(item.state)}</div>
          <div className="collaboration-task-copy"><strong>{item.title}</strong><p>{box === 'inbox' ? `来自 ${item.origin.displayName}` : `交给 ${item.assignee.displayName}`} · 修订 {item.revision} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p></div>
          <span>版本 {item.version}</span>
          {item.lastReason && <div className="collaboration-return-reason"><strong>退回原因</strong><span>{item.lastReason}</span></div>}
          <div className="collaboration-task-actions">
            <button className="secondary-button" disabled={activeItemId === item.id} onClick={() => void download(item)}>下载工作簿</button>
            {box === 'inbox' && item.state === 'PENDING_PROCESSING' && <button className="primary-button" disabled={activeItemId === item.id} onClick={() => void act(item, 'claim')}>{activeItemId === item.id ? '处理中…' : '接收任务'}</button>}
            {box === 'inbox' && item.state === 'PROCESSING' && <button className="secondary-button danger" disabled={activeItemId === item.id} onClick={() => { setReturningItemId(item.id); setReturnReason(''); setError('') }}>退回建表人</button>}
          </div>
          {returningItemId === item.id && <div className="collaboration-return-form">
            <label>退回原因<textarea autoFocus maxLength={1000} value={returnReason} onChange={event => setReturnReason(event.target.value)} placeholder="请写明需要修改的工作表、行号和问题。" /></label>
            <div><button className="secondary-button" onClick={() => { setReturningItemId(''); setReturnReason('') }}>取消</button><button className="primary-button" disabled={activeItemId === item.id || !returnReason.trim()} onClick={() => void act(item, 'return-source')}>确认退回</button></div>
          </div>}
        </article>)}</section></>}
  </div>
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = { PENDING_PROCESSING: '待接收', PROCESSING: '处理中', NEEDS_SOURCE_FIX: '待源头修正', PENDING_ORIGIN_REVIEW: '待复核', READY_TO_MERGE: '待合并', COMPLETED: '已完成' }
  return labels[state] ?? state
}
