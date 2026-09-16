import type {
  ConnectorKind,
  ConnectorSummary,
  ConnectorTestResult
} from '@shared/contracts'

export interface Connector {
  readonly id: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly enabled: boolean
  readonly capabilities: ConnectorSummary['capabilities']
  isConfigured(): boolean
  testConnection(): Promise<ConnectorTestResult>
}

export abstract class PlannedConnector implements Connector {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly kind: ConnectorKind
  abstract readonly capabilities: ConnectorSummary['capabilities']
  readonly enabled = false

  isConfigured(): boolean {
    return false
  }

  async testConnection(): Promise<ConnectorTestResult> {
    return {
      ok: false,
      message: `${this.name} 连接器结构已建立，需在“接口设置”中配置企业凭据后启用。`
    }
  }
}
