import type { PageId } from './navigation'

type IconName = PageId | 'collapse' | 'expand'

const iconPaths: Record<IconName, React.ReactNode> = {
  dashboard: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 21v-7h6v7" /></>,
  'new-task': <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></>,
  'existing-products': <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18M13 14h5m-2.5-2.5v5" /></>,
  supplement: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 7v10M7 12h10" /></>,
  'material-lifecycle': <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></>,
  'material-data': <><path d="M5 3h11l3 3v15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M16 3v4h4M7 11h10M7 15h10M7 19h6" /></>,
  'collaboration-tasks': <><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h5" /><path d="m17 16 2 2 3-3" /></>,
  'base-files': <><path d="M5 3h11l3 3v15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M16 3v4h4M7 11h10M7 15h10M7 19h6" /></>,
  integrations: <><path d="M8 7h12M8 17h12M4 7h.01M4 17h.01" /><path d="m15 4 3 3-3 3m-6 4-3 3 3 3" /></>,
  settings: <><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /><circle cx="12" cy="12" r="4" /></>,
  collapse: <><path d="M4 5h16M4 12h16M4 19h16" /><path d="m14 9-3 3 3 3" /></>,
  expand: <><path d="M4 5h16M4 12h16M4 19h16" /><path d="m10 9 3 3-3 3" /></>
}

export function NavigationIcon({ name }: { name: IconName }): React.JSX.Element {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>
}
