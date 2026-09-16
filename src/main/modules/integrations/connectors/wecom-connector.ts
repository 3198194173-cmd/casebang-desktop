import { PlannedConnector } from '../connector'

export class WeComConnector extends PlannedConnector {
  readonly id = 'wecom-default'
  readonly name = '企业微信'
  readonly kind = 'wecom' as const
  readonly capabilities: Array<'text' | 'file' | 'link'> = ['text', 'file', 'link']
}
