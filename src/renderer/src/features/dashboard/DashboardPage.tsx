import type { AppSnapshot, BusinessRole } from '@shared/contracts'
import type { PageId } from '../../app/navigation'

interface Props {
  snapshot: AppSnapshot
  onNavigate(page: PageId): void
  businessRole: BusinessRole | null
}

export function DashboardPage({ snapshot, onNavigate, businessRole }: Props): React.JSX.Element {
  const readyFiles = Object.values(snapshot.baseFiles).filter((file) => file.status === 'ready').length
  const configuredConnectors = snapshot.connectors.filter((connector) => connector.configured).length

  if (!businessRole) return <div className="stack-xl">
    <section className="flow-center-heading"><div><h2>登录并选择业务端</h2><p>上游和下游使用不同的工具，但共同查看同一份工作簿记录和当前阶段。</p></div><button className="primary-button" onClick={() => onNavigate('settings')}>前往登录</button></section>
    <section className="role-explanation"><article><strong>上游建表</strong><span>新系列建表、系列补产品、产品补机型和最终审核合并</span></article><article><strong>下游加工</strong><span>物料码、69 码和图档核对；不显示上游建表工具</span></article></section>
  </div>

  if (businessRole === 'downstream') return <div className="stack-xl">
    <section className="flow-center-heading"><div><h2>下游加工工作台</h2><p>只显示新建表的编码与图档核对工具，不显示上游建表功能。</p></div><button className="primary-button" onClick={() => onNavigate('material-lifecycle')}>开始加工</button></section>
    <article className="downstream-entry"><div><small>共享记录</small><h3>工作簿进度</h3><p>双方查看同一条记录，只在阶段变化时更新并通知对方。</p></div><button className="secondary-button" onClick={() => onNavigate('collaboration-tasks')}>查看记录</button></article>
  </div>

  return (
    <div className="stack-xl">
      <section className="flow-center-heading">
        <div>
          <h2>从建表到建档，一条主流程</h2>
          <p>三种建表入口任选一种；生成的新建表进入共享记录，不再发送或下载副本。</p>
        </div>
        <button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>查看工作簿记录</button>
      </section>

      <section className="business-flow-map" aria-label="CASEBANG 主业务流程">
        <header><strong>第一阶段 · 上游建表</strong><span>任选一种入口</span></header>
        <div className="workflow-catalog upstream">
          <article className="workflow-entry active">
            <header><span className="workflow-entry-icon">▦</span><mark>入口 A</mark></header>
            <h3>新系列建表</h3>
            <p>裁图、命名、产品编码、质检并生成新建表。</p>
            <footer><button onClick={() => onNavigate('new-task')}>开始</button></footer>
          </article>
          <article className="workflow-entry active">
            <header><span className="workflow-entry-icon">⊞</span><mark>入口 B</mark></header>
            <h3>系列补产品</h3>
            <p>复用已有系列与图案信息，为新增产品生成记录。</p>
            <footer><button onClick={() => onNavigate('existing-products')}>开始</button></footer>
          </article>
          <article className="workflow-entry active">
            <header><span className="workflow-entry-icon">＋</span><mark>入口 C</mark></header>
            <h3>产品补机型</h3>
            <p>从总物料表匹配原产品，为目标机型生成新增记录。</p>
            <footer><button onClick={() => onNavigate('supplement')}>开始</button></footer>
          </article>
        </div>
        <div className="flow-merge"><span>任一建表流程完成并通过质检</span><strong>建立共享记录</strong></div>
        <article className="downstream-entry">
          <div><small>第二阶段 · 下游加工</small><h3>新建表加工</h3><p>下游在同一工作簿上完成物料码、69 码和图档核对，然后更新阶段等待上游复核。</p></div>
          <button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>查看共享记录</button>
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
