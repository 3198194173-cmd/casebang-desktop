import { PlannedConnector } from '../connector'

export class DingTalkConnector extends PlannedConnector {
  readonly id = 'dingtalk-default'
  readonly name = '钉钉'
  readonly kind = 'dingtalk' as const
  readonly capabilities: Array<'text' | 'file' | 'link'> = ['text', 'file', 'link']
}
