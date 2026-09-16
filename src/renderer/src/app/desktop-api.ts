import type { CasebangDesktopApi } from '@shared/contracts'

export const desktopApi = (window as Window & { casebang: CasebangDesktopApi }).casebang
