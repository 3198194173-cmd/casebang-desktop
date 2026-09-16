import type { CasebangDesktopApi } from '@shared/contracts'

declare global {
  interface Window {
    casebang: CasebangDesktopApi
  }
}

export {}
