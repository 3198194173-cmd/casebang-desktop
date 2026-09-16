import { PlannedConnector } from '../connector'

export class GenericHttpConnector extends PlannedConnector {
  readonly id = 'generic-http-default'
  readonly name = '通用 HTTP 接口'
  readonly kind = 'generic-http' as const
  readonly capabilities: Array<'text' | 'file' | 'link'> = ['text', 'file', 'link']
}
