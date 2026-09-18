import { useEffect, useState } from 'react'
import type { CollaborationWorkItem } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import { accountError, useAccount } from '../../app/account-context'

const STAGES = [
  ['PENDING_PROCESSING', '已建表，待下游加工'],
  ['PROCESSING', '下游加工中'],
  ['PENDING_ORIGIN_REVIEW', '待上游审核'],
  ['NEEDS_SOURCE_FIX', '需要修改'],
  ['READY_TO_MERGE', '审核通过，待合并'],
  ['COMPLETED', '已合并完成']
] as const

export function CollaborationTasksPage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { account } = useAccount()
  const [items, setItems] = useState<CollaborationWorkItem[]>([])
  const [selectedStages, setSelectedStages] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [activeItemId, setActiveItemId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async (): Promise<void> => {
    if (account?.status !== 'signed-in') { setItems([]); return }
    setBusy(true); setError('')
    try {
      const next = await desktopApi.collaboration.workItems()
      setItems(next)
      setSelectedStages(Object.fromEntries(next.map(item => [item.id, item.state])))
    } catch (reason) {
      setError(accountError(reason, '工作簿记录读取失败'))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { if (enabled) void load() }, [enabled, account?.status, account?.user?.id])

  const updateStage = async (item: CollaborationWorkItem): Promise<void> => {
    const state = selectedStages[item.id]
    if (!state || state === item.state) return
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.act({ workItemId: item.id, action: 'update-stage', state, expectedVersion: item.version, revision: item.revision })
      setItems(current => current.map(entry => entry.id === result.item.id ? result.item : entry))
      setSelectedStages(current => ({ ...current, [result.item.id]: result.item.state }))
      setMessage('当前阶段已保存，通知事件已进入中央服务。')
    } catch (reason) {
      setError(accountError(reason, '阶段更新失败'))
    } finally {
      setActiveItemId('')
    }
  }

  const openOnline = async (item: CollaborationWorkItem): Promise<void> => {
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      await desktopApi.collaboration.openOnlineWorkbook({ workItemId: item.id })
      setMessage('已在浏览器打开同一份 WPS 共享工作簿；双方修改将保存为中央修订。')
    } catch (reason) {
      setError(accountError(reason, 'WPS 在线工作簿打开失败'))
    } finally {
      setActiveItemId('')
    }
  }

  return <div className="collaboration-page">
    <header className="collaboration-hero"><div><span className="eyebrow">共享工作簿</span><h2>工作簿记录</h2><p>上下游同步查看工作簿修订和当前阶段。</p></div><button className="secondary-button" disabled={busy} onClick={() => void load()}>{busy ? '刷新中…' : '刷新记录'}</button></header>
    {account?.status === 'signed-in' && <section className="collaboration-account-strip"><span className="status-dot" /><strong>{account.user?.displayName}</strong><span>{account.user?.businessRole === 'upstream' ? '上游建表' : '下游加工'} · 中央记录已连接</span></section>}
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <section className="collaboration-list">
      {!busy && !items.length ? <div className="collaboration-empty"><strong>暂无工作簿记录</strong><p>建立共享工作簿后，上游或下游身份都可以从这里打开并编辑。</p></div> : items.map(item => {
        const selectedStage = selectedStages[item.id] ?? item.state
        return <article key={item.id} className="collaboration-task-card">
          <div className="collaboration-state">{stateLabel(item.state)}</div>
          <div className="collaboration-task-copy"><strong>{item.title}</strong><p>创建人：{item.origin.displayName} · 最后编辑：{item.lastEditor?.displayName ?? item.origin.displayName} · {formatEditTime(item.lastEditedAt ?? item.createdAt)} · 修订 {item.revision}</p></div>
          <span>记录版本 {item.version}</span>
          {item.lastReason && <div className="collaboration-return-reason"><strong>阶段备注</strong><span>{item.lastReason}</span></div>}
          <div className="collaboration-stage-editor"><button className="secondary-button" disabled={activeItemId === item.id} onClick={() => void openOnline(item)}>{activeItemId === item.id ? '正在打开…' : 'WPS 在线编辑'}</button><label>当前进度<select value={selectedStage} onChange={event => setSelectedStages(current => ({ ...current, [item.id]: event.target.value }))}>{STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="primary-button" disabled={activeItemId === item.id || selectedStage === item.state} onClick={() => void updateStage(item)}>{activeItemId === item.id ? '保存中…' : '保存阶段'}</button></div>
          <small className="collaboration-online-note">双方从这里打开同一个中央 file_id；WPS 保存后自动形成新的工作簿修订。</small>
        </article>
      })}
    </section>
  </div>
}

function stateLabel(state: string): string {
  return STAGES.find(([value]) => value === state)?.[1] ?? state
}

function formatEditTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date)
}
