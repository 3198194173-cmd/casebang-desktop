import { useEffect, useState } from 'react'
import type { CollaborationWorkItem } from '@shared/contracts'
import type { LifecycleDraft } from '@shared/lifecycle-contracts'
import { desktopApi } from '../../app/desktop-api'
import { accountError, useAccount } from '../../app/account-context'

type RecordFilter = 'active' | 'completed' | 'cancelled'

export function CollaborationTasksPage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { account } = useAccount()
  const canArchive = account?.status === 'signed-in' && account.user?.businessRole === 'upstream'
  const [items, setItems] = useState<CollaborationWorkItem[]>([])
  const [filter, setFilter] = useState<RecordFilter>('active')
  const [busy, setBusy] = useState(false)
  const [activeItemId, setActiveItemId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [externalDraft, setExternalDraft] = useState<LifecycleDraft | null>(null)

  const load = async (): Promise<void> => {
    if (account?.status !== 'signed-in') { setItems([]); return }
    setBusy(true); setError('')
    try { setItems(await desktopApi.collaboration.workItems()) }
    catch (reason) { setError(accountError(reason, '工作簿记录读取失败')) }
    finally { setBusy(false) }
  }

  useEffect(() => { if (enabled) void load() }, [enabled, account?.status, account?.user?.id])

  const updateState = async (item: CollaborationWorkItem, state: 'COMPLETED' | 'CANCELLED'): Promise<void> => {
    const label = state === 'COMPLETED' ? '完成并归档' : '作废并停止后续加工'
    if (!window.confirm(`确认将“${item.title}”${label}？工作簿和编辑记录会保留。`)) return
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      const result = await desktopApi.collaboration.act({ workItemId: item.id, action: 'update-stage', state, expectedVersion: item.version, revision: item.revision })
      setItems(current => current.map(entry => entry.id === result.item.id ? result.item : entry))
      setMessage(state === 'COMPLETED' ? '工作簿已完成并归档。' : '工作簿已作废；历史文件与编辑记录仍保留。')
    } catch (reason) { setError(accountError(reason, '工作簿状态更新失败')) }
    finally { setActiveItemId('') }
  }

  const openOnline = async (item: CollaborationWorkItem): Promise<void> => {
    setActiveItemId(item.id); setError(''); setMessage('')
    try {
      await desktopApi.collaboration.openOnlineWorkbook({ workItemId: item.id })
      setMessage('已在浏览器打开同一份 WPS 共享工作簿；保存后会形成“手动修改”记录。')
    } catch (reason) { setError(accountError(reason, 'WPS 在线工作簿打开失败')) }
    finally { setActiveItemId('') }
  }

  const importExternalWorkbook = async (): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try {
      const draft = await desktopApi.lifecycle.importWorkbook()
      if (!draft) return
      setExternalDraft(draft)
      setMessage('外部工作簿已导入。请先打开并整理工作表名称，保存后再上传为共享表。')
    } catch (reason) { setError(accountError(reason, '外部共享表导入失败')) }
    finally { setBusy(false) }
  }

  const openExternalDraft = async (): Promise<void> => {
    if (!externalDraft) return
    setActiveItemId('external'); setError('')
    try { await desktopApi.collaboration.openLocalWorkbook({ path: externalDraft.sourcePath }); setMessage('已打开外部工作簿，请整理工作表名称并保存。图片工作表用于后续印刷图档对比。') }
    catch (reason) { setError(accountError(reason, '外部工作簿打开失败')) }
    finally { setActiveItemId('') }
  }

  const publishExternalDraft = async (): Promise<void> => {
    if (!externalDraft) return
    setActiveItemId('external'); setError(''); setMessage('')
    try {
      const inspection = await desktopApi.lifecycle.inspectWorkbook({ path: externalDraft.sourcePath })
      if (inspection.warnings.some(warning => warning.includes('缺少“图片”分表') || warning.includes('缺少“条码”分表'))) {
        setExternalDraft(current => current ? { ...current, warnings: inspection.warnings } : current)
        setError('请先在 WPS 中确保业务分表名称包含“条码”和“图片”，保存后再上传。')
        return
      }
      const result = await desktopApi.collaboration.publishWorkbook({ path: externalDraft.sourcePath, title: externalDraft.title, sourceWorkflow: 'manual' })
      setExternalDraft(null)
      await load()
      setMessage(result.duplicate ? '该外部工作簿已经存在共享记录。' : `外部工作簿已建立为共享表，中央版本 ${result.item.revision}。`)
    } catch (reason) { setError(accountError(reason, '外部共享表上传失败')) }
    finally { setActiveItemId('') }
  }

  const visibleItems = items.filter(item => filter === 'completed'
    ? item.state === 'COMPLETED'
    : filter === 'cancelled' ? item.state === 'CANCELLED' : !['COMPLETED', 'CANCELLED'].includes(item.state))

  return <div className="collaboration-page">
    <header className="collaboration-hero"><div><span className="eyebrow">共享工作簿</span><h2>工作簿记录</h2><p>管理系列工作簿，并查看谁在何时通过软件加工或 WPS 手动修改。</p></div><button className="secondary-button" disabled={busy} onClick={() => void load()}>{busy ? '刷新中…' : '刷新记录'}</button></header>
    {account?.status === 'signed-in' && <section className="collaboration-account-strip"><span className="status-dot" /><strong>{account.user?.displayName}</strong><span>{account.user?.businessRole === 'upstream' ? '上游建表' : '下游加工'} · 中央记录已连接</span></section>}
    {account?.status === 'signed-in' && <section className="collaboration-import-panel"><div><strong>外部导入共享表</strong><p>当上游未能生成标准工作簿时，可直接导入外部 .xlsx。工作表名称只需包含“条码”和“图片”关键词：条码表保留类目、69码、物料编码（工厂）、物料名称；图片表保留条码名、产品编码、图片对应名称（大写）和截图。可存在多个图片分表，核验时按产品类别自动选择。</p>{externalDraft && <small>当前文件：{externalDraft.title} · {externalDraft.warnings.length ? `有 ${externalDraft.warnings.length} 条结构提醒，请先整理分表` : '结构已读取'}</small>}</div><div>{!externalDraft ? <button className="secondary-button" disabled={busy} onClick={() => void importExternalWorkbook()}>{busy ? '导入中…' : '选择外部工作簿'}</button> : <><button className="secondary-button" disabled={activeItemId === 'external'} onClick={() => void openExternalDraft()}>打开并整理工作表</button><button className="primary-button" disabled={activeItemId === 'external'} onClick={() => void publishExternalDraft()}>上传为共享表</button></>}</div></section>}
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <nav className="collaboration-tabs"><button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>进行中</button><button aria-pressed={filter === 'completed'} onClick={() => setFilter('completed')}>已完成</button><button aria-pressed={filter === 'cancelled'} onClick={() => setFilter('cancelled')}>已作废</button></nav>
    <section className="collaboration-list">
      {!busy && !visibleItems.length ? <div className="collaboration-empty"><strong>当前分类暂无记录</strong><p>完成和作废的工作簿会保留文件与时间轴，但不再占用进行中列表。</p></div> : visibleItems.map(item => <article key={item.id} className="collaboration-task-card">
        <div className="collaboration-state">{stateLabel(item.state)}</div>
        <div className="collaboration-task-copy"><strong>{item.title}</strong><p>创建人：{item.origin.displayName} · 中央修订 {item.revision}</p></div>
        <span>记录版本 {item.version}</span>
        <div className="collaboration-task-actions">{filter === 'active' ? <><button className="secondary-button" disabled={activeItemId === item.id} onClick={() => void openOnline(item)}>{activeItemId === item.id ? '正在处理…' : 'WPS 在线编辑'}</button>{canArchive && <button className="primary-button" disabled={activeItemId === item.id} onClick={() => void updateState(item, 'COMPLETED')}>完成并归档</button>}<button className="danger" disabled={activeItemId === item.id} onClick={() => void updateState(item, 'CANCELLED')}>作废</button></> : <small>归档记录只用于追溯，不再进入加工和编辑流程。</small>}</div>
        <aside className="collaboration-timeline"><strong>编辑时间轴</strong>{item.activities.length ? item.activities.map(activity => <div key={activity.id}><span className={activity.kind}>{activity.kind === 'manual' ? '手动修改' : '软件加工'}</span><p>{activity.actor.displayName}<time>{formatEditTime(activity.occurredAt)}</time></p></div>) : <small>暂无编辑记录</small>}</aside>
      </article>)}
    </section>
  </div>
}

function stateLabel(state: string): string {
  if (state === 'COMPLETED') return '已完成'
  if (state === 'CANCELLED') return '已作废'
  return '进行中'
}

function formatEditTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date)
}
