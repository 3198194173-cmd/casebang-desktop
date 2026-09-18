import { useEffect, useState } from 'react'
import type { ApplicationSettings, BusinessRole } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'
import { useAccount } from '../../app/account-context'

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
  const [loginRole, setLoginRole] = useState<BusinessRole>('upstream')
  const { account, busy: accountBusy, login: loginAccount, logout: logoutAccount } = useAccount()

  useEffect(() => {
    void desktopApi.settings.get()
      .then((value) => setSettings(value))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取设置失败'))
      .finally(() => setLoading(false))
  }, [])

  const login = async (): Promise<void> => {
    setError(null); setMessage('已打开钉钉登录页面，正在等待确认…')
    try {
      await loginAccount(loginRole); setMessage('钉钉账号登录成功，已显示所选业务端功能。')
    } catch (reason) {
      setMessage(null); setError(accountError(reason, '钉钉登录失败'))
    }
  }

  const logout = async (): Promise<void> => {
    setError(null); setMessage(null)
    try {
      await logoutAccount(); setMessage('已退出钉钉账号。')
    } catch (reason) {
      setError(accountError(reason, '退出登录失败'))
    }
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
            ? <><div className="account-identity"><span>{account.user.displayName.slice(0, 1)}</span><div><strong>{account.user.displayName}</strong><small>{account.user.businessRole === 'upstream' ? '上游建表' : '下游加工'} · {account.status === 'offline' ? '离线保留' : '已在线验证'}</small></div></div><p>{account.message} 退出后可重新选择业务端；业务端只切换工具，不限制共享工作簿编辑。</p></>
            : <><p>{account?.message ?? '正在读取钉钉账号状态…'} 登录前请选择该账号使用的业务端。</p><div className="business-role-picker">
              <label className={loginRole === 'upstream' ? 'selected' : ''}><input type="radio" name="business-role" checked={loginRole === 'upstream'} onChange={() => setLoginRole('upstream')} /><span><strong>上游建表</strong><small>建表、提交、复核、合并</small></span></label>
              <label className={loginRole === 'downstream' ? 'selected' : ''}><input type="radio" name="business-role" checked={loginRole === 'downstream'} onChange={() => setLoginRole('downstream')} /><span><strong>下游加工</strong><small>物料码、69 码和图档核对</small></span></label>
            </div></>}
        </div>
        <div className="account-panel-actions">
          <span className={account?.status === 'signed-in' ? 'status-label ready' : 'status-label'}>{account?.status === 'signed-in' ? '已登录' : account?.status === 'offline' ? '离线' : '未登录'}</span>
          {account?.user
            ? <button className="secondary-button" disabled={accountBusy} onClick={() => void logout()}>{accountBusy ? '处理中…' : '退出登录'}</button>
            : <button className="primary-button" disabled={accountBusy || loading || !settings.allowNetworkFeatures} onClick={() => void login()}>{accountBusy ? '等待钉钉确认…' : `以${loginRole === 'upstream' ? '上游' : '下游'}身份登录`}</button>}
        </div>
      </section>
    </div>
  )
}

function accountError(reason: unknown, fallback: string): string { return reason instanceof Error ? reason.message : fallback }
