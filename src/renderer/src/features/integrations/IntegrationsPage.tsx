import { useEffect, useState } from 'react'
import type { AiSettingsSummary, ConnectorSummary } from '@shared/contracts'
import { desktopApi } from '../../app/desktop-api'

const DEFAULT_AI_SETTINGS: AiSettingsSummary = {
  provider: 'aliyun',
  model: 'qwen3-vl-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  configured: false,
  apiKeyPreview: null
}

const CLOUD_MODEL_OPTIONS = [
  { id: 'qwen3-vl-flash', label: 'Qwen3-VL Flash（推荐，低成本）' },
  { id: 'qwen3-vl-plus', label: 'Qwen3-VL Plus（更高精度）' },
  { id: 'qwen-vl-plus', label: 'Qwen-VL Plus（兼容备用）' }
]

export function IntegrationsPage({ connectors }: { connectors: ConnectorSummary[] }): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [aiSettings, setAiSettings] = useState<AiSettingsSummary>(DEFAULT_AI_SETTINGS)
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    void desktopApi.ai.getSettings().then(setAiSettings).catch((reason: unknown) => {
      setMessage(reason instanceof Error ? reason.message : 'AI 设置读取失败')
    })
  }, [])

  const saveAi = async (): Promise<void> => {
    try {
      setBusy('ai-save')
      const saved = await desktopApi.ai.saveSettings({ provider: aiSettings.provider, model: aiSettings.model, baseUrl: aiSettings.baseUrl, apiKey })
      setAiSettings(saved)
      setApiKey('')
      setMessage('阿里云百炼设置已保存；API Key 已使用 Windows 安全存储加密。')
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'AI 设置保存失败')
    } finally {
      setBusy(null)
    }
  }

  const testAi = async (): Promise<void> => {
    try {
      setBusy('ai-test')
      const saved = await desktopApi.ai.saveSettings({ provider: aiSettings.provider, model: aiSettings.model, baseUrl: aiSettings.baseUrl, apiKey })
      setAiSettings(saved)
      setApiKey('')
      const result = await desktopApi.ai.testConnection()
      setMessage(result.message)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'AI 接口连接失败')
    } finally {
      setBusy(null)
    }
  }

  const test = async (connectorId: string): Promise<void> => {
    try {
      setBusy(connectorId)
      const result = await desktopApi.integrations.test({ connectorId })
      setMessage(result.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="stack-xl">
      <section className="panel cloud-ai-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">VISION AI</span><h3>图片命名模型</h3><p className="muted">识别裁剪后的图案，提供中英文对应建议；只有英文名称会写入表格。</p></div>
          <span className={aiSettings.configured ? 'status-label ready' : 'status-label'}>{aiSettings.configured ? '可使用' : '待配置'}</span>
        </div>
        <div className="ai-settings-grid">
          <div className="field"><span>服务提供方</span><div className="provider-lock"><strong>阿里云百炼</strong><small>系统唯一 AI 服务提供商</small></div></div>
          <label className="field"><span>视觉模型</span><select value={aiSettings.model} onChange={(event) => setAiSettings({ ...aiSettings, model: event.target.value })}>{CLOUD_MODEL_OPTIONS.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</select><small>默认使用 Flash；名称不理想时可切换到 Plus。</small></label>
          <label className="field ai-base-url"><span>Base URL</span><input value={aiSettings.baseUrl} onChange={(event) => setAiSettings({ ...aiSettings, baseUrl: event.target.value })} /></label>
          <label className="field ai-api-key"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={aiSettings.apiKeyPreview ?? '填写阿里云百炼 API Key'} /><small>{aiSettings.configured ? '留空会保留现有 Key；重新输入可替换。' : 'Key 仅保存在本机 Windows 加密存储中。'}</small></label>
        </div>
        <div className="ai-cost-note"><strong>阿里云批量视觉</strong><span>同一次请求最多发送 24 张独立裁图；常见的 19 个区域由逐张调用合并为 1 次批量调用，减少重复提示词和请求次数。</span></div>
        <div className="ai-actions"><button className="secondary-button" disabled={busy !== null} onClick={() => void testAi()}>{busy === 'ai-test' ? '测试中…' : '测试当前连接'}</button><button className="primary-button" disabled={busy !== null} onClick={() => void saveAi()}>{busy === 'ai-save' ? '保存中…' : '保存 AI 设置'}</button></div>
      </section>

      {message && <div className="alert info">{message}</div>}
      <section className="notice-card"><strong>一套发送流程，多个平台连接器</strong><p>业务任务只提交“文件 + 接收目标”，钉钉、企业微信或后续 ERP 各自负责鉴权、上传和发送。</p></section>
      <section className="integration-grid">
        {connectors.map((connector) => (
          <article className="integration-card" key={connector.id}>
            <div className={`integration-logo ${connector.kind}`}>{connector.kind === 'dingtalk' ? '钉' : connector.kind === 'wecom' ? '企' : 'API'}</div>
            <div className="integration-content"><span className={connector.configured ? 'status-label ready' : 'status-label'}>{connector.configured ? '已配置' : '待配置'}</span><h3>{connector.name}</h3><p>能力：{connector.capabilities.map((item) => ({ text: '消息', file: '文件', link: '链接' })[item]).join('、')}</p></div>
            <button className="secondary-button" disabled={busy !== null} onClick={() => void test(connector.id)}>{busy === connector.id ? '检测中…' : '检查连接'}</button>
          </article>
        ))}
      </section>
      <section className="panel compact"><h3>接口接入原则</h3><p className="muted">个人微信没有稳定的官方文件发送接口。正式版优先接企业微信和钉钉企业应用；如果平台只允许发送链接，将由文件发布模块先上传到公司允许的存储，再发送安全下载链接。</p></section>
    </div>
  )
}
