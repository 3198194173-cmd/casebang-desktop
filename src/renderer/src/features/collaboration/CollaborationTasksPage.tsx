import { useEffect, useState } from 'react'
import type { BusinessRole, CollaborationWorkItem } from '@shared/contracts'
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
  const [loginRole, setLoginRole] = useState<BusinessRole>('downstream')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const beginLogin = async (): Promise<void> => {
    const roleName = loginRole === 'upstream' ? '上游建表' : '下游建档'
    if (!window.confirm(`确认将这个钉钉账号绑定为“${roleName}”吗？\n\n首次绑定后不能直接切换为另一种业务身份。`)) return
    await login(loginRole)
  }
  const load = async (nextBox = box): Promise<void> => {
    if (account?.status !== 'signed-in') { setItems([]); return }
    setBusy(true); setError('')
    try { setItems(await desktopApi.collaboration.workItems(nextBox)) }
    catch (reason) { setError(accountError(reason, '协同任务读取失败')) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (enabled) void load() }, [enabled, box, account?.status, account?.user?.id])
  useEffect(() => { if (account?.user?.businessRole) setBox(account.user.businessRole === 'upstream' ? 'sent' : 'inbox') }, [account?.user?.businessRole])
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
      if (action === 'claim') {
        try {
          const opened = await desktopApi.collaboration.openWorkbook({ workItemId: result.item.id, title: result.item.title, revision: result.item.revision })
          setMessage(`任务已接收，并已打开本机工作副本：${opened.path}`)
        } catch (reason) {
          setMessage('任务已接收，但工作副本没有自动打开；可点击“继续处理”重试。')
          setError(accountError(reason, '工作副本打开失败'))
        }
      } else {
        setMessage('任务已退回建表人，退回原因已记录。')
      }
    } catch (reason) { setError(accountError(reason, '任务操作失败')) }
    finally { setActiveItemId('') }
  }
  const openWorkbook = async (item: CollaborationWorkItem): Promise<void> => {
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.openWorkbook({ workItemId: item.id, title: item.title, revision: item.revision })
      setMessage(`已打开本机工作副本：${result.path}`)
    } catch (reason) { setError(accountError(reason, '工作副本打开失败')) }
    finally { setActiveItemId('') }
  }

  return <div className="collaboration-page">
    <header className="collaboration-hero"><div><span className="eyebrow">{account?.user?.businessRole === 'upstream' ? '任务交接' : '下游处理'}</span><h2>建档任务</h2><p>{account?.user?.businessRole === 'upstream' ? '查看已提交任务、退回原因与后续复核状态。' : '统一查看接收、处理和回传；正常任务应由三个上游建表流程提交。'}</p></div>{account?.user?.businessRole === 'upstream' && <button className="secondary-button" onClick={onOpenLifecycle}>导入旧表测试</button>}</header>
    {account?.status !== 'signed-in' ? <section className="collaboration-login role-login"><div><strong>选择业务身份后登录</strong><p>不同钉钉账号分别绑定上游建表或下游建档，服务器会同时校验权限。</p><div className="inline-role-picker"><label><input type="radio" checked={loginRole === 'upstream'} onChange={() => setLoginRole('upstream')} />上游建表</label><label><input type="radio" checked={loginRole === 'downstream'} onChange={() => setLoginRole('downstream')} />下游建档</label></div></div><button className="primary-button" disabled={accountBusy} onClick={() => void beginLogin()}>{accountBusy ? '等待确认…' : '钉钉登录'}</button></section>
      : <><section className="collaboration-account-strip"><span className="status-dot" /><strong>{account.user?.displayName}</strong><span>{account.user?.businessRole === 'upstream' ? '上游建表账号' : '下游建档账号'} · 权限已验证</span></section>
        <nav className="collaboration-tabs">{account.user?.businessRole === 'downstream' ? <button aria-pressed="true" onClick={() => switchBox('inbox')}>待我处理</button> : <button aria-pressed="true" onClick={() => switchBox('sent')}>我发出的</button>}<button disabled={busy} onClick={() => void load()}>{busy ? '刷新中…' : '刷新'}</button></nav>
        {error && <div className="alert error">{error}</div>}
        {message && <div className="alert success">{message}</div>}
        <section className="collaboration-list">{!busy && !items.length ? <div className="collaboration-empty"><strong>{box === 'inbox' ? '暂无待处理任务' : '还没有发出任务'}</strong><p>{box === 'inbox' ? '另一企业账号提交给你的建档任务会显示在这里。' : '请先从新系列建表、系列补产品或产品补机型完成生成与质检。'}</p></div> : items.map(item => <article key={item.id} className="collaboration-task-card">
          <div className="collaboration-state">{stateLabel(item.state)}</div>
          <div className="collaboration-task-copy"><strong>{item.title}</strong><p>{box === 'inbox' ? `来自 ${item.origin.displayName}` : `交给 ${item.assignee.displayName}`} · 修订 {item.revision} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p></div>
          <span>版本 {item.version}</span>
          {item.lastReason && <div className="collaboration-return-reason"><strong>退回原因</strong><span>{item.lastReason}</span></div>}
          <div className="collaboration-task-actions">
            {!(box === 'inbox' && item.state === 'PENDING_PROCESSING') && <button className="secondary-button" disabled={activeItemId === item.id} onClick={() => void openWorkbook(item)}>{box === 'inbox' ? '继续处理' : '查看提交版本'}</button>}
            {box === 'inbox' && item.state === 'PENDING_PROCESSING' && <button className="primary-button" disabled={activeItemId === item.id} onClick={() => void act(item, 'claim')}>{activeItemId === item.id ? '正在准备…' : '接收并开始处理'}</button>}
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
