export type PageId = 'dashboard' | 'base-files' | 'new-task' | 'integrations' | 'settings' | 'supplement' | 'existing-products' | 'collaboration-tasks' | 'material-lifecycle'

export interface NavigationItem {
  id: PageId
  label: string
  icon: string
}

export interface NavigationGroup {
  id: 'overview' | 'workflows' | 'resources' | 'system' | 'collaboration'
  label: string
  items: NavigationItem[]
}

export const NAV_GROUPS: NavigationGroup[] = [
  { id: 'overview', label: '总览', items: [{ id: 'dashboard', label: '流程中心', icon: '⌂' }] },
  { id: 'workflows', label: '业务流程', items: [{ id: 'new-task', label: '表格编码', icon: '▦' }, { id: 'existing-products', label: '原有系列补充新产品编码', icon: '⊞' }, { id: 'supplement', label: '原有产品补充新机型', icon: '＋' }] },
  { id: 'collaboration', label: '协同闭环', items: [{ id: 'collaboration-tasks', label: '协同任务', icon: '↔' }, { id: 'material-lifecycle', label: '物料建档', icon: '⇆' }] },
  {
    id: 'resources',
    label: '资源配置',
    items: [
      { id: 'base-files', label: '基础资料', icon: '▤' },
      { id: 'integrations', label: 'AI 与接口', icon: '⇄' }
    ]
  },
  { id: 'system', label: '系统', items: [{ id: 'settings', label: '系统设置', icon: '⚙' }] }
]

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items)
