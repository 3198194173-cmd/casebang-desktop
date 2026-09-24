import { useEffect, useState } from 'react'
import type { CollaborationActivity, CollaborationWorkItem } from '@shared/contracts'
import type { LifecycleDraft } from '@shared/lifecycle-contracts'
import { desktopApi } from '../../app/desktop-api'
import { accountError, useAccount } from '../../app/account-context'
import { LocalWorkbookEditPanel } from './LocalWorkbookEditPanel'

type RecordFilter = 'active' | 'completed' | 'cancelled'

export function CollaborationTasksPage({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { account } = useAccount()
  const canArchive = account?.status === 'signed-in' && account.user?.businessRole === 'upstream'
  const [items, setItems] = useState<CollaborationWorkItem[]>([])
  const [filter, setFilter] = useState<RecordFilter>('active')
  const [busy, setBusy] = useState(false)
  const [activeItemId, setActiveItemId] = useState('')
  const [editingId, setEditingId] = useState('')
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
    <header className="collaboration-hero"><div><h2>协同工作簿</h2><p>管理系列工作簿，并查看软件加工与本地编辑提交记录。</p></div><button className="secondary-button" disabled={busy} onClick={() => void load()}>{busy ? '刷新中…' : '刷新记录'}</button></header>
    {account?.status === 'signed-in' && <section className="collaboration-account-strip"><span className="status-dot" /><strong>{account.user?.displayName}</strong><span>{account.user?.businessRole === 'upstream' ? '上游建表' : '下游加工'} · 中央记录已连接</span></section>}
    {account?.status === 'signed-in' && <section className="collaboration-import-panel"><div><strong>外部导入共享表</strong><p>上游未生成标准工作簿时，可导入外部 .xlsx。</p><details className="collaboration-import-help"><summary>查看工作表格式要求</summary><p>工作表名称需包含“条码”和“图片”关键词：条码表保留类目、69码、物料编码（工厂）、物料名称；图片表保留条码名、产品编码、图片对应名称（大写）和截图。可存在多个图片分表，核验时按产品类别自动选择。</p></details>{externalDraft && <small>当前文件：{externalDraft.title} · {externalDraft.warnings.length ? `有 ${externalDraft.warnings.length} 条结构提醒，请先整理分表` : '结构已读取'}</small>}</div><div>{!externalDraft ? <button className="secondary-button" disabled={busy} onClick={() => void importExternalWorkbook()}>{busy ? '导入中…' : '选择外部工作簿'}</button> : <><button className="secondary-button" disabled={activeItemId === 'external'} onClick={() => void openExternalDraft()}>打开并整理工作表</button><button className="primary-button" disabled={activeItemId === 'external'} onClick={() => void publishExternalDraft()}>上传为共享表</button></>}</div></section>}
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <nav className="collaboration-tabs"><button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>进行中</button><button aria-pressed={filter === 'completed'} onClick={() => setFilter('completed')}>已完成</button><button aria-pressed={filter === 'cancelled'} onClick={() => setFilter('cancelled')}>已作废</button></nav>
    <section className="collaboration-list">
      {!busy && !visibleItems.length ? <div className="collaboration-empty"><strong>当前分类暂无记录</strong><p>完成和作废的工作簿会保留文件与时间轴，但不再占用进行中列表。</p></div> : visibleItems.map(item => <article key={item.id} className="collaboration-task-card">
        <div className="collaboration-state">{stateLabel(item.state)}</div>
        <div className="collaboration-task-copy"><strong>{item.title}</strong><p>创建人：{item.origin.displayName} · 中央修订 {item.revision}</p></div>
        <span>记录版本 {item.version}</span>
        <div className="collaboration-task-actions">{filter === 'active' ? <><button className="secondary-button" disabled={activeItemId === item.id} onClick={() => setEditingId(value => value === item.id ? '' : item.id)}>{editingId === item.id ? '隐藏编辑面板（不清缓存）' : '本地编辑与提交'}</button>{canArchive && <button className="primary-button" disabled={activeItemId === item.id} onClick={() => void updateState(item, 'COMPLETED')}>完成并归档</button>}<button className="danger" disabled={activeItemId === item.id} onClick={() => void updateState(item, 'CANCELLED')}>作废</button></> : <small>归档记录只用于追溯，不再进入加工和编辑流程。</small>}</div>
        {editingId === item.id && filter === 'active' && <LocalWorkbookEditPanel workItemId={item.id} currentRevision={item.revision} onSaved={async () => { await load() }} />}
        <ActivityTimeline key={`${item.id}-${item.revision}`} item={item} />
      </article>)}
    </section>
  </div>
}

function ActivityTimeline({ item }: { item: CollaborationWorkItem }): React.JSX.Element {
  const [activities, setActivities] = useState<CollaborationActivity[]>(item.activities)
  const [nextBeforeVersion, setNextBeforeVersion] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async (more: boolean): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await desktopApi.collaboration.activities({ workItemId: item.id, ...(more && nextBeforeVersion ? { beforeVersion: nextBeforeVersion } : {}) })
      setActivities(previous => more ? [...previous, ...result.activities] : result.activities)
      setNextBeforeVersion(result.nextBeforeVersion)
      setLoaded(true)
    } catch (cause) { setError(accountError(cause, '读取编辑时间轴失败')) }
    finally { setBusy(false) }
  }
  return <details className="collaboration-timeline" onToggle={event => { if (event.currentTarget.open && !loaded) void load(false) }}>
    <summary>编辑时间轴 · {loaded ? `${activities.length}${nextBeforeVersion ? '+' : ''}` : `最近 ${activities.length} 条`}</summary>
    {activities.map(activity => <div key={activity.id}><span className={activity.kind}>{activity.source === 'published' ? '建立共享表' : activity.source === 'weboffice' ? '历史 WPS' : activity.kind === 'manual' ? '本地修改' : '软件加工'}</span><p>{activity.actor.displayName}{activity.revision ? ` · 中央修订 ${activity.revision}` : ''}{activity.reason ? ` · ${activity.reason}` : ''}<time>{formatEditTime(activity.occurredAt)}</time></p></div>)}
    {!activities.length && <small>暂无编辑记录</small>}
    {nextBeforeVersion && <button className="secondary-button" disabled={busy} onClick={() => void load(true)}>{busy ? '加载中…' : '查看更多'}</button>}
    {error && <small className="alert error">{error}</small>}
  </details>
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
