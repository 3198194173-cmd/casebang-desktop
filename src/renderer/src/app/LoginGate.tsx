import { useState } from 'react'
import type { BusinessRole } from '@shared/contracts'
import { accountError, useAccount } from './account-context'
import { NavigationIcon } from './NavigationIcon'

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
    return <main className="login-gate"><section className="login-gate-card loading" role="status"><img src="./casebang-app-icon.png" alt="CASEBANG" /><strong>正在验证钉钉登录状态…</strong></section></main>
  }

  return <main className="login-gate">
    <div className="login-shell">
      <section className="login-overview" aria-label="CASEBANG 工作台介绍">
        <header className="login-gate-brand"><img src="./casebang-app-icon.png" alt="CASEBANG" /><div><strong>CASEBANG</strong><span>业务自动化平台</span></div></header>
        <div className="login-overview-content">
          <span className="login-overview-kicker">企业工作空间</span>
          <h1>一个工作台，<br /><span>连接建表与加工。</span></h1>
          <p>从系列建表到下游核验，按当前职责进入对应工具，工作簿记录在同一处查看。</p>
          <div className="login-workflow" aria-label="主要工作流程">
            <div><span>01</span><strong>建立产品表</strong><small>整理系列、产品与机型</small></div>
            <div><span>02</span><strong>共享工作簿</strong><small>记录处理阶段与修改</small></div>
            <div><span>03</span><strong>完成下游核验</strong><small>处理编码与印刷图档</small></div>
          </div>
        </div>
        <small className="login-overview-footer">仅限已授权的企业钉钉成员使用</small>
      </section>
      <section className="login-gate-card" aria-labelledby="login-title">
        <div className="login-gate-copy"><span className="login-card-kicker">登录工作台</span><h2 id="login-title">使用钉钉账号登录</h2><p>选择本次使用的业务端，然后前往钉钉完成授权。</p></div>
        {(localError || error) && <div className="alert error" role="alert">{localError || error}</div>}
        {account?.status === 'offline' && <div className="login-gate-offline">本机保留的账号尚未通过在线验证，请重新登录后继续。</div>}
        <fieldset className="business-role-picker login-role-picker">
          <legend>选择业务端</legend>
          <label className={businessRole === 'upstream' ? 'selected' : ''}><span className="login-role-icon"><NavigationIcon name="new-task" /></span><span className="login-role-copy"><strong>上游建表</strong><small>建表、提交、复核与合并</small></span><input type="radio" name="login-role" checked={businessRole === 'upstream'} onChange={() => setBusinessRole('upstream')} /></label>
          <label className={businessRole === 'downstream' ? 'selected' : ''}><span className="login-role-icon"><NavigationIcon name="material-lifecycle" /></span><span className="login-role-copy"><strong>下游加工</strong><small>物料码、69 码与图档核对</small></span><input type="radio" name="login-role" checked={businessRole === 'downstream'} onChange={() => setBusinessRole('downstream')} /></label>
        </fieldset>
        <button className="primary-button login-gate-submit" type="button" disabled={busy} onClick={() => void submit()}>{busy ? '等待钉钉确认…' : `以${businessRole === 'upstream' ? '上游建表' : '下游加工'}身份继续`}<span aria-hidden="true">→</span></button>
        <p className="login-gate-note">登录将在钉钉完成验证；此处不提供游客入口。</p>
      </section>
    </div>
  </main>
}
