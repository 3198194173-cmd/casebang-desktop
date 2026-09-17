import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { BusinessRole, CollaborationAccountState } from '@shared/contracts'
import { desktopApi } from './desktop-api'

interface AccountContextValue {
  account: CollaborationAccountState | null
  busy: boolean
  error: string | null
  refresh(): Promise<void>
  login(businessRole: BusinessRole): Promise<CollaborationAccountState>
  logout(): Promise<CollaborationAccountState>
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [account, setAccount] = useState<CollaborationAccountState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try { setAccount(await desktopApi.account.get()); setError(null) }
    catch (reason) { setError(accountError(reason, '账号状态读取失败')) }
  }
  useEffect(() => { void refresh() }, [])

  const login = async (businessRole: BusinessRole): Promise<CollaborationAccountState> => {
    setBusy(true); setError(null)
    try { const value = await desktopApi.account.login(businessRole); setAccount(value); return value }
    catch (reason) { const message = accountError(reason, '钉钉登录失败'); setError(message); throw new Error(message) }
    finally { setBusy(false) }
  }
  const logout = async (): Promise<CollaborationAccountState> => {
    setBusy(true); setError(null)
    try { const value = await desktopApi.account.logout(); setAccount(value); return value }
    catch (reason) { const message = accountError(reason, '退出登录失败'); setError(message); throw new Error(message) }
    finally { setBusy(false) }
  }
  const value = useMemo(() => ({ account, busy, error, refresh, login, logout }), [account, busy, error])
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext)
  if (!value) throw new Error('AccountProvider is missing')
  return value
}

export function accountError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback
  return reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}
