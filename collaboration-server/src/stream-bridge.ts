import { randomUUID } from 'node:crypto'
import { DWClient, EventAck, type DWClientDownStream } from 'dingtalk-stream'
import type pg from 'pg'
import type { ServerConfig } from './config.js'

interface LogLike {
  info(value: object, message: string): void
  warn(value: object, message: string): void
  error(value: object, message: string): void
}

export class DingTalkStreamBridge {
  private client: DWClient | null = null
  constructor(private readonly config: ServerConfig['dingtalk'], private readonly pool: pg.Pool, private readonly log: LogLike) {}
  get enabled(): boolean { return this.config.enabled }
  get connected(): boolean { return this.client?.connected === true }
  async start(): Promise<void> {
    if (!this.config.enabled || this.client) return
    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      keepAlive: true,
      autoReconnect: true,
      debug: false,
      maxPendingEventHandlers: 20,
      maxPendingCallbackHandlers: 20
    })
    client.registerAllEventListener((message, signal) => this.persistEvent(message, signal))
    this.client = client
    await client.connect()
    if (client.connected) this.log.info({ component: 'dingtalk-stream' }, '钉钉 Stream 已连接')
    else this.log.warn({ component: 'dingtalk-stream' }, '钉钉 Stream 首次连接未成功，SDK 将按退避策略重试')
  }
  stop(): void { this.client?.disconnect(); this.client = null }
  private async persistEvent(message: DWClientDownStream, signal?: AbortSignal): Promise<{ status: EventAck; message?: string }> {
    if (signal?.aborted) return { status: EventAck.LATER, message: 'connection replaced' }
    const eventId = message.headers.eventId || message.headers.messageId
    try {
      await this.pool.query(`INSERT INTO stream_events
        (id,event_id,corp_id,topic,event_type,headers,raw_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO NOTHING`, [
        randomUUID(), eventId, message.headers.eventCorpId || null, message.headers.topic,
        message.headers.eventType || null, message.headers, message.data
      ])
      this.log.info({ eventId, topic: message.headers.topic, eventType: message.headers.eventType }, '钉钉事件已持久化')
      return { status: EventAck.SUCCESS }
    } catch (error) {
      this.log.error({ eventId, error: error instanceof Error ? error.message : String(error) }, '钉钉事件保存失败，将请求稍后重试')
      return { status: EventAck.LATER, message: 'persistence failed' }
    }
  }
}
