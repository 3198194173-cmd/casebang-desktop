import { useEffect, useState } from 'react'
import type { ApplicationSettings, CollaborationAccountState } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'

const FALLBACK_SETTINGS: ApplicationSettings = {
  autoSaveDrafts: true,
  requireQualityCheck: true,
  allowNetworkFeatures: true
}

const SETTING_ROWS: Array<{
  key: keyof ApplicationSettings
  label: string
  description: string
}> = [
  { key: 'autoSaveDrafts', label: '自动保存任务草稿', description: '保留任务恢复设置，避免意外退出后丢失工作进度' },
  { key: 'requireQualityCheck', label: '导出前强制质检', description: '重名、重码、缺图或公式异常时禁止导出' },
  { key: 'allowNetworkFeatures', label: '允许联网功能', description: '云端视觉 AI、钉钉登录和外部接口需要开启' }
]

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<ApplicationSettings>(FALLBACK_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<keyof ApplicationSettings | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [account, setAccount] = useState<CollaborationAccountState | null>(null)
  const [accountBusy, setAccountBusy] = useState(false)

  useEffect(() => {
    void desktopApi.settings.get()
      .then((value) => setSettings(value))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取设置失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void desktopApi.account.get()
      .then(setAccount)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '账号状态读取失败'))
  }, [])

  const login = async (): Promise<void> => {
    setAccountBusy(true); setError(null); setMessage('已打开钉钉登录页面，正在等待确认…')
    try {
      const value = await desktopApi.account.login()
      setAccount(value); setMessage('钉钉账号登录成功。')
    } catch (reason) {
      setMessage(null); setError(accountError(reason, '钉钉登录失败'))
    } finally { setAccountBusy(false) }
  }

  const logout = async (): Promise<void> => {
    setAccountBusy(true); setError(null); setMessage(null)
    try {
      setAccount(await desktopApi.account.logout()); setMessage('已退出钉钉账号。')
    } catch (reason) {
      setError(accountError(reason, '退出登录失败'))
    } finally { setAccountBusy(false) }
  }

  const toggle = async (key: keyof ApplicationSettings): Promise<void> => {
    const previous = settings
    const next = { ...settings, [key]: !settings[key] }
    setSettings(next)
    setSavingKey(key)
    setMessage(null)
    setError(null)
    try {
      setSettings(await desktopApi.settings.save(next))
      setMessage('设置已保存，重新启动软件后仍会保留。')
    } catch (reason) {
      setSettings(previous)
      setError(reason instanceof Error ? reason.message : '保存设置失败')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="settings-page">
      <div className="two-column settings-columns">
        <section className="panel">
          <span className="eyebrow">APPLICATION</span>
          <h3>应用设置</h3>
          {SETTING_ROWS.map((item) => (
            <div className="setting-row" key={item.key}>
              <div><strong>{item.label}</strong><small>{item.description}</small></div>
              <button
                type="button"
                role="switch"
                aria-checked={settings[item.key]}
                aria-label={item.label}
                className={settings[item.key] ? 'toggle on' : 'toggle'}
                disabled={loading || savingKey !== null}
                onClick={() => void toggle(item.key)}
              >
                <span className="sr-only">{savingKey === item.key ? '正在保存' : settings[item.key] ? '已开启' : '已关闭'}</span>
              </button>
            </div>
          ))}
          {message && <div className="settings-message success">✓ {message}</div>}
          {error && <div className="settings-message error">! {error}</div>}
        </section>
        <section className="panel">
          <span className="eyebrow">SECURITY</span>
          <h3>安全与数据</h3>
          <div className="info-row"><span>原表保护</span><strong>只读处理</strong></div>
          <div className="info-row"><span>API 凭据</span><strong>Windows 加密存储</strong></div>
          <div className="info-row"><span>页面权限</span><strong>沙箱隔离</strong></div>
          <div className="info-row"><span>设置状态</span><strong>{loading ? '读取中' : '已同步'}</strong></div>
        </section>
      </div>
      <section className="panel settings-note account-panel">
        <div className="account-panel-copy">
          <span className="eyebrow">ACCOUNT ACCESS</span>
          <h3>账号与组织登录</h3>
          {account?.user
            ? <><div className="account-identity"><span>{account.user.displayName.slice(0, 1)}</span><div><strong>{account.user.displayName}</strong><small>CASEBANG 企业账号 · {account.status === 'offline' ? '离线保留' : '已在线验证'}</small></div></div><p>{account.message}</p></>
            : <p>{account?.message ?? '正在读取钉钉账号状态…'} 登录后可参与跨电脑任务交接；应用密钥不会保存到本机。</p>}
        </div>
        <div className="account-panel-actions">
          <span className={account?.status === 'signed-in' ? 'status-label ready' : 'status-label'}>{account?.status === 'signed-in' ? '已登录' : account?.status === 'offline' ? '离线' : '未登录'}</span>
          {account?.user
            ? <button className="secondary-button" disabled={accountBusy} onClick={() => void logout()}>{accountBusy ? '处理中…' : '退出登录'}</button>
            : <button className="primary-button" disabled={accountBusy || loading || !settings.allowNetworkFeatures} onClick={() => void login()}>{accountBusy ? '等待钉钉确认…' : '钉钉登录'}</button>}
        </div>
      </section>
    </div>
  )
}

function accountError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback
  return reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}
