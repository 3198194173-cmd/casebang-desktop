import type { WebFrameMain } from 'electron'

export function isTrustedSender(frame: WebFrameMain | null): boolean {
  if (!frame) return false

  try {
    const senderUrl = new URL(frame.url)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL

    if (developmentUrl) {
      return senderUrl.origin === new URL(developmentUrl).origin
    }

    return senderUrl.protocol === 'file:'
  } catch {
    return false
  }
}

export function assertTrustedSender(frame: WebFrameMain | null): void {
  if (!isTrustedSender(frame)) {
    throw new Error('已拒绝来自非应用页面的请求')
  }
}
