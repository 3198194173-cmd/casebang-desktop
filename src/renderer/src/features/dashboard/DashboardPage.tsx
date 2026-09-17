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
    <section className="flow-center-heading"><div><h2>登录并选择业务身份</h2><p>上游账号负责建表与复核；下游账号负责编码、核图和回传。</p></div><button className="primary-button" onClick={() => onNavigate('settings')}>前往登录</button></section>
    <section className="role-explanation"><article><strong>上游建表</strong><span>新系列建表、系列补产品、产品补机型、提交与最终复核</span></article><article><strong>下游建档</strong><span>接收任务、编码处理、图档核对、上传修订并返回复核</span></article></section>
  </div>

  if (businessRole === 'downstream') return <div className="stack-xl">
    <section className="flow-center-heading"><div><h2>下游建档工作台</h2><p>只显示分配给当前账号的建档任务，不开放上游建表入口。</p></div><button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>查看待处理任务</button></section>
    <article className="downstream-entry"><div><small>当前业务身份 · 下游建档</small><h3>建档任务</h3><p>接收任务后软件会自动打开工作副本；编码、核图和新修订回传将继续在这里接入。</p></div><button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>进入任务中心</button></article>
  </div>

  return (
    <div className="stack-xl">
      <section className="flow-center-heading">
        <div>
          <h2>从建表到建档，一条主流程</h2>
          <p>先选择一种建表入口，质检通过后提交建档任务；三种入口不会依次执行。</p>
        </div>
        <button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>查看建档任务</button>
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
        <div className="flow-merge"><span>任一建表流程完成并通过质检</span><strong>提交</strong></div>
        <article className="downstream-entry">
          <div><small>第二阶段 · 下游处理</small><h3>建档任务</h3><p>另一账号接收文件，完成物料码、69码和图档核对，再交回建表人复核。</p></div>
          <button className="primary-button" onClick={() => onNavigate('collaboration-tasks')}>进入任务中心</button>
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
