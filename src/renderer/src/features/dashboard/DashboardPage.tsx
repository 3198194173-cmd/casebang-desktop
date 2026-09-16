import type { AppSnapshot } from '@shared/contracts'
import type { PageId } from '../../app/navigation'

interface Props {
  snapshot: AppSnapshot
  onNavigate(page: PageId): void
}

export function DashboardPage({ snapshot, onNavigate }: Props): React.JSX.Element {
  const readyFiles = Object.values(snapshot.baseFiles).filter((file) => file.status === 'ready').length
  const configuredConnectors = snapshot.connectors.filter((connector) => connector.configured).length

  return (
    <div className="stack-xl">
      <section className="flow-center-heading">
        <div>
          <h2>选择业务流程</h2>
          <p>不同岗位使用各自的流程，功能可以持续扩展。</p>
        </div>
        <button className="primary-button" onClick={() => onNavigate('new-task')}>开始表格编码</button>
      </section>

      <section className="workflow-catalog">
        <article className="workflow-entry active">
          <header><span className="workflow-entry-icon">⊞</span><mark>已启用</mark></header>
          <h3>原有系列补充新产品编码</h3>
          <p>选择已有系列、比对历史图案并复用命名，为新增产品分配新编码。</p>
          <footer><button onClick={() => onNavigate('existing-products')}>进入流程</button></footer>
        </article>
        <article className="workflow-entry active">
          <header><span className="workflow-entry-icon">▦</span><mark>已启用</mark></header>
          <h3>表格编码与命名</h3>
          <p>裁图、命名、编码、质检和 Excel 导出。</p>
          <footer><span>产品与运营</span><button onClick={() => onNavigate('new-task')}>进入流程</button></footer>
        </article>
        <article className="workflow-entry active">
          <header><span className="workflow-entry-icon">＋</span></header>
          <h3>原有产品补充新机型</h3>
          <p>导入总物料表与补齐表，替换机型并导出已匹配物料。</p>
          <footer><button onClick={() => onNavigate('supplement')}>进入流程</button></footer>
        </article>
      </section>

      <section className="panel dashboard-status-panel">
        <div className="panel-heading"><h3>运行状态</h3></div>
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
            <button className="check-row" onClick={() => onNavigate('integrations')}>
              <span className={configuredConnectors > 0 ? 'check ready' : 'check'}>
                {configuredConnectors > 0 ? '✓' : '!'}
              </span>
                <span><strong>外部接口</strong><small>{configuredConnectors} 个已配置</small></span>
              </button>
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
