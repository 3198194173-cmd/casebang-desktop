import { useEffect, useState } from 'react'
import type { AppSnapshot } from '@shared/contracts'
import { NAV_GROUPS, NAV_ITEMS, type PageId } from './navigation'
import { BaseFilesPage } from '../features/base-files/BaseFilesPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { IntegrationsPage } from '../features/integrations/IntegrationsPage'
import { NewTaskPage } from '../features/tasks/NewTaskPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { DraftStatus } from './use-draft-state'
import { desktopApi } from './desktop-api'
import { SupplementPage } from '../features/supplement/SupplementPage'
import { MaterialLifecyclePage } from '../features/lifecycle/MaterialLifecyclePage'
import { useAccount } from './account-context'
import { CollaborationTasksPage } from '../features/collaboration/CollaborationTasksPage'
import { LoginGate } from './LoginGate'
import { MaterialDataPage } from '../features/material-data/MaterialDataPage'

export function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('dashboard')
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { account, initialized: accountInitialized, busy: accountBusy, error: accountError } = useAccount()
  const businessRole = account?.user?.businessRole ?? null
  const visibleGroups = NAV_GROUPS.filter((group) => {
    if (group.id === 'overview' || group.id === 'system') return true
    if (!businessRole) return false
    if (group.id === 'workflows' || group.id === 'resources') return businessRole === 'upstream'
    if (group.id === 'processing') return businessRole === 'downstream'
    return group.id === 'records'
  })

  const refresh = async (): Promise<void> => {
    try {
      setSnapshot(await desktopApi.app.getSnapshot())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '应用数据读取失败')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const visible = visibleGroups.some(group => group.items.some(item => item.id === page))
    if (!visible) setPage('dashboard')
  }, [businessRole, page])

  if (!accountInitialized || account?.status !== 'signed-in') return <LoginGate />

  const renderPage = (): React.JSX.Element => {
    if (!snapshot) return <div className="loading-card">正在初始化应用…</div>
    if (page === 'existing-products' || page === 'supplement' || page === 'new-task' || page === 'material-lifecycle' || page === 'material-data' || page === 'collaboration-tasks') return <></>
    if (page === 'base-files') return <BaseFilesPage snapshot={snapshot} onChanged={refresh} />

    if (page === 'integrations') return <IntegrationsPage connectors={snapshot.connectors} />
    if (page === 'settings') return <SettingsPage />
    return <DashboardPage snapshot={snapshot} onNavigate={setPage} businessRole={businessRole} />
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="./casebang-app-icon.png" alt="CASEBANG" />
          <div>
            <strong>CASEBANG</strong>
            <span>业务自动化平台</span>
          </div>
        </div>
        <nav className="navigation" aria-label="主导航">
          {visibleGroups.map((group) => (
            <section className="nav-group" key={group.id}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => (
                <button
                  className={page === item.id ? 'nav-item active' : 'nav-item'}
                  key={item.id}
                  onClick={() => setPage(item.id)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span><i className="status-dot" />服务正常</span>
          <small>v{snapshot?.appVersion ?? '0.1.0'}</small>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="topbar-section">{NAV_GROUPS.find((group) => group.items.some((item) => item.id === page))?.label}</span>
            <h1>{NAV_ITEMS.find((item) => item.id === page)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <button className={`global-account ${account?.status ?? 'loading'}`} disabled={accountBusy} onClick={() => setPage('settings')}>
              <span>{account?.user?.displayName.slice(0, 1) ?? '钉'}</span>
              <div><strong>{account.user?.displayName}</strong><small>{businessRole === 'upstream' ? '上游建表' : '下游加工'}</small></div>
            </button>
            <div className="topbar-badge">Windows 桌面版</div>
          </div>
        </header>
        {(error || accountError) && <div className="alert error">{error ?? accountError}</div>}
        <section className={`page-content ${page === 'new-task' ? 'new-task-page' : ''} ${page === 'material-lifecycle' ? 'material-lifecycle-page' : ''}`}>
          {(page === 'existing-products' || page === 'new-task' || page === 'supplement') && <DraftStatus />}
          {snapshot && businessRole === 'upstream' && <><div hidden={page !== 'existing-products'}><NewTaskPage existingSeries snapshot={snapshot} onDataChanged={refresh} /></div><div hidden={page !== 'new-task'}><NewTaskPage snapshot={snapshot} onDataChanged={refresh} /></div><div hidden={page !== 'supplement'}><SupplementPage active={page === 'supplement'} onOpenMaterialData={() => setPage('material-data')} /></div></>}
          {renderPage()}
          {snapshot && businessRole === 'downstream' && <div hidden={page !== 'material-lifecycle'}><MaterialLifecyclePage enabled={page === 'material-lifecycle'} /></div>}
          {snapshot && businessRole && <div hidden={page !== 'material-data'}><MaterialDataPage enabled={page === 'material-data'} /></div>}
          {businessRole && <div hidden={page !== 'collaboration-tasks'}><CollaborationTasksPage enabled={page === 'collaboration-tasks'} /></div>}
        </section>
      </main>
    </div>
  )
}
