import { useState } from 'react'
import type { BusinessRole } from '@shared/contracts'
import { accountError, useAccount } from './account-context'

export function LoginGate(): React.JSX.Element {
  const { account, initialized, busy, error, login } = useAccount()
  const [businessRole, setBusinessRole] = useState<BusinessRole>('upstream')
  const [localError, setLocalError] = useState('')

  const submit = async (): Promise<void> => {
    setLocalError('')
    try {
      await login(businessRole)
    } catch (reason) {
      setLocalError(accountError(reason, '钉钉登录失败'))
    }
  }

  if (!initialized) {
    return <main className="login-gate"><section className="login-gate-card loading"><img src="./casebang-app-icon.png" alt="CASEBANG" /><strong>正在验证钉钉登录状态…</strong></section></main>
  }

  return <main className="login-gate">
    <section className="login-gate-card">
      <header className="login-gate-brand"><img src="./casebang-app-icon.png" alt="CASEBANG" /><div><strong>CASEBANG</strong><span>业务自动化平台</span></div></header>
      <div className="login-gate-copy"><span className="eyebrow">ACCOUNT ACCESS</span><h1>使用钉钉账号登录</h1><p>软件仅向已完成企业钉钉验证的成员开放。请选择本次进入的业务端，然后前往钉钉完成授权。</p></div>
      {(localError || error) && <div className="alert error">{localError || error}</div>}
      {account?.status === 'offline' && <div className="login-gate-offline">本机保留的账号尚未通过在线验证，请重新登录后继续。</div>}
      <div className="business-role-picker login-role-picker">
        <label className={businessRole === 'upstream' ? 'selected' : ''}><input type="radio" name="login-role" checked={businessRole === 'upstream'} onChange={() => setBusinessRole('upstream')} /><span><strong>上游建表</strong><small>建表、提交、复核与合并</small></span></label>
        <label className={businessRole === 'downstream' ? 'selected' : ''}><input type="radio" name="login-role" checked={businessRole === 'downstream'} onChange={() => setBusinessRole('downstream')} /><span><strong>下游加工</strong><small>物料码、69 码与图档核对</small></span></label>
      </div>
      <button className="primary-button login-gate-submit" disabled={busy} onClick={() => void submit()}>{busy ? '等待钉钉确认…' : `以${businessRole === 'upstream' ? '上游' : '下游'}身份登录`}</button>
      <small className="login-gate-note">没有游客入口。退出登录或会话失效后，将返回此页面。</small>
    </section>
  </main>
}
