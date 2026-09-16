import { useEffect, useState } from 'react'
import type { ApplicationSettings } from '@shared/contracts'
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

  useEffect(() => {
    void desktopApi.settings.get()
      .then((value) => setSettings(value))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取设置失败'))
      .finally(() => setLoading(false))
  }, [])

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
      <section className="panel settings-note">
        <div>
          <span className="eyebrow">ACCOUNT ACCESS</span>
          <h3>账号与组织登录</h3>
          <p>当前版本使用本机工作区，不要求账号登录。后续接入钉钉时，可在这里显示登录人员、所属组织、权限角色和退出登录入口。</p>
        </div>
        <span className="status-label">尚未接入</span>
      </section>
    </div>
  )
}
