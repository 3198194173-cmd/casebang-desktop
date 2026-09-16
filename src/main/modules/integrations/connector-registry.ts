import type { ConnectorSummary, ConnectorTestResult } from '@shared/contracts'
import type { Connector } from './connector'
import { DingTalkConnector } from './connectors/dingtalk-connector'
import { GenericHttpConnector } from './connectors/generic-http-connector'
import { WeComConnector } from './connectors/wecom-connector'
import type { SettingsRepository } from '@main/infrastructure/settings-repository'

export class ConnectorRegistry {
  private readonly connectors: Map<string, Connector>

  constructor(private readonly settings: SettingsRepository, connectors: Connector[] = [
    new DingTalkConnector(),
    new WeComConnector(),
    new GenericHttpConnector()
  ]) {
    this.connectors = new Map(connectors.map((connector) => [connector.id, connector]))
  }

  list(): ConnectorSummary[] {
    return [...this.connectors.values()].map((connector) => ({
      id: connector.id,
      name: connector.name,
      kind: connector.kind,
      enabled: connector.enabled,
      configured: connector.isConfigured(),
      capabilities: [...connector.capabilities]
    }))
  }

  async test(connectorId: string): Promise<ConnectorTestResult> {
    if (!(await this.settings.getApplicationSettings()).allowNetworkFeatures) {
      throw new Error('联网功能已关闭。请先在“系统设置”中开启。')
    }
    const connector = this.connectors.get(connectorId)
    if (!connector) throw new Error('找不到指定连接器')
    return connector.testConnection()
  }
}
