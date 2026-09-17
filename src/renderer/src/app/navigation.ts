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
  { id: 'overview', label: '工作台', items: [{ id: 'dashboard', label: '业务总览', icon: '⌂' }] },
  { id: 'workflows', label: '上游建表', items: [{ id: 'new-task', label: '新系列建表', icon: '▦' }, { id: 'existing-products', label: '系列补产品', icon: '⊞' }, { id: 'supplement', label: '产品补机型', icon: '＋' }] },
  { id: 'collaboration', label: '任务中心', items: [{ id: 'collaboration-tasks', label: '建档任务', icon: '↔' }] },
  {
    id: 'resources',
    label: '资料与配置',
    items: [
      { id: 'base-files', label: '基础数据', icon: '▤' },
      { id: 'integrations', label: 'AI 与接口', icon: '⇄' }
    ]
  },
  { id: 'system', label: '系统', items: [{ id: 'settings', label: '系统设置', icon: '⚙' }] }
]

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items)
