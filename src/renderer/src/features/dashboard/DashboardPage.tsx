import { useEffect, useState } from 'react'
import type { AppSnapshot, BusinessRole, CollaborationWorkItem } from '@shared/contracts'
import type { PageId } from '../../app/navigation'
import { desktopApi } from '../../app/desktop-api'
import { NavigationIcon } from '../../app/NavigationIcon'

interface Props {
  snapshot: AppSnapshot
  onNavigate(page: PageId): void
  businessRole: BusinessRole | null
}

export function DashboardPage({ snapshot, onNavigate, businessRole }: Props): React.JSX.Element {
  const readyFiles = Object.values(snapshot.baseFiles).filter((file) => file.status === 'ready').length
  const [workItems, setWorkItems] = useState<CollaborationWorkItem[]>([])
  const [recordsLoading, setRecordsLoading] = useState(true)
  const [recordsError, setRecordsError] = useState(false)

  useEffect(() => {
    let current = true
    void desktopApi.collaboration.workItems().then((items) => {
      if (current) setWorkItems(items)
    }).catch(() => {
      if (current) setRecordsError(true)
    }).finally(() => {
      if (current) setRecordsLoading(false)
    })
    return () => { current = false }
  }, [])

  const recentRecords = [...workItems]
    .sort((left, right) => Date.parse(right.lastEditedAt || right.createdAt) - Date.parse(left.lastEditedAt || left.createdAt))
    .slice(0, 5)

  if (!businessRole) return <div className="stack-xl">
    <section className="flow-center-heading"><div><h2>登录并选择业务端</h2><p>上游和下游使用不同的工具，但共同查看同一份工作簿记录和当前阶段。</p></div><button className="primary-button" onClick={() => onNavigate('settings')}>前往登录</button></section>
    <section className="role-explanation"><article><strong>上游建表</strong><span>新系列建表、系列补产品、产品补机型和最终审核合并</span></article><article><strong>下游加工</strong><span>物料码、69 码和图档核对；不显示上游建表工具</span></article></section>
  </div>

  if (businessRole === 'downstream') return <div className="stack-xl">
    <section className="flow-center-heading"><div><h2>选择今天要处理的工作</h2><p>物料编码、69 码和图档核验使用同一份共享工作簿。</p></div><button className="primary-button" onClick={() => onNavigate('material-lifecycle')}>开始加工</button></section>
    <article className="downstream-entry"><div><small>共享记录</small><h3>工作簿进度</h3><p>查看真实阶段与编辑记录，继续处理当前工作簿。</p></div><button className="secondary-button" onClick={() => onNavigate('collaboration-tasks')}>查看记录</button></article>
    <RecentWorkItems items={recentRecords} loading={recordsLoading} error={recordsError} onOpen={() => onNavigate('collaboration-tasks')} />
  </div>

  return (
    <div className="stack-xl">
      <section className="flow-center-heading">
        <div>
          <h2>选择建表流程</h2>
          <p>从新系列、已有系列或机型补齐开始，工作簿进度会保存在共享记录中。</p>
        </div>
        <button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>查看工作簿记录</button>
      </section>

      <section className="business-flow-map" aria-label="CASEBANG 主业务流程">
        <div className="workflow-catalog upstream">
          <article className="workflow-entry active">
            <header><span className="workflow-entry-icon"><NavigationIcon name="new-task" /></span></header>
            <h3>新系列建表</h3>
            <p>裁图、命名、产品编码、质检并生成新建表。</p>
            <footer><button onClick={() => onNavigate('new-task')}>进入流程 <span aria-hidden="true">→</span></button></footer>
          </article>
          <article className="workflow-entry active">
            <header><span className="workflow-entry-icon"><NavigationIcon name="existing-products" /></span></header>
            <h3>系列补产品</h3>
            <p>复用已有系列与图案信息，为新增产品生成记录。</p>
            <footer><button onClick={() => onNavigate('existing-products')}>进入流程 <span aria-hidden="true">→</span></button></footer>
          </article>
          <article className="workflow-entry active">
            <header><span className="workflow-entry-icon"><NavigationIcon name="supplement" /></span></header>
            <h3>产品补机型</h3>
            <p>从总物料表匹配原产品，为目标机型生成新增记录。</p>
            <footer><button onClick={() => onNavigate('supplement')}>进入流程 <span aria-hidden="true">→</span></button></footer>
          </article>
        </div>
      </section>

      <RecentWorkItems items={recentRecords} loading={recordsLoading} error={recordsError} onOpen={() => onNavigate('collaboration-tasks')} />

      <section className="panel dashboard-status-panel">
        <div className="panel-heading"><h3>基础资料状态</h3><button className="text-button" onClick={() => onNavigate('base-files')}>管理基础数据 →</button></div>
        <div className="dashboard-status-grid">
          <div className="check-list">
            {Object.values(snapshot.baseFiles).map((file) => (
              <button className="check-row" key={file.kind} onClick={() => onNavigate('base-files')}>
                <span className={file.status === 'ready' ? 'check ready' : 'check'}>
                  {file.status === 'ready' ? '✓' : '!'}
                </span>
                <span><strong>{file.label}</strong><small>{file.fileName ?? '尚未导入'}</small></span>
              </button>
            ))}
            </div>
            <div className="dashboard-ready-summary">
              <span>基础资料</span>
              <strong>{readyFiles} / {Object.keys(snapshot.baseFiles).length}</strong>
              <small>{Object.values(snapshot.baseFiles).filter((file) => file.kind !== 'productImageMapping').every((file) => file.status === 'ready') ? '流程可以使用' : '需要完成配置'}</small>
              <button className="secondary-button" onClick={() => onNavigate('base-files')}>管理基础资料</button>
            </div>
          </div>
      </section>
    </div>
  )
}

function RecentWorkItems({ items, loading, error, onOpen }: { items: CollaborationWorkItem[]; loading: boolean; error: boolean; onOpen(): void }): React.JSX.Element {
  return <section className="panel dashboard-recent-panel">
    <div className="panel-heading"><h3>最近工作簿</h3><button className="text-button" onClick={onOpen}>查看全部 →</button></div>
    {loading ? <p className="dashboard-record-empty">正在读取工作簿记录…</p>
      : error ? <p className="dashboard-record-empty">暂时无法读取记录，可在工作簿记录页重试。</p>
        : !items.length ? <p className="dashboard-record-empty">暂无共享工作簿。完成建表后会显示在这里。</p>
          : <div className="dashboard-record-list">
            <div className="dashboard-record-head"><span>工作簿名称</span><span>最近更新</span><span>阶段</span><span>操作</span></div>
            {items.map((item) => <div className="dashboard-record-row" key={item.id}>
              <strong title={item.title}>{item.title}</strong>
              <time>{formatTime(item.lastEditedAt || item.createdAt)}</time>
              <span className="dashboard-record-state">{item.state === 'COMPLETED' ? '已完成' : item.state === 'CANCELLED' ? '已作废' : '进行中'}</span>
              <button className="text-button" onClick={onOpen}>查看记录</button>
            </div>)}
          </div>}
  </section>
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
