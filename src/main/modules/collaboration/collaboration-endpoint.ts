const DEFAULT_COLLABORATION_ORIGIN = 'https://collab.casebang.tech'

export function resolveCollaborationOrigin(value = process.env.CASEBANG_COLLAB_ORIGIN): string {
  const candidate = value?.trim() || DEFAULT_COLLABORATION_ORIGIN
  const url = new URL(candidate)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('协同服务地址必须使用 HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('协同服务地址不能包含账号、查询参数或片段')
  }
  return url.toString().replace(/\/$/, '')
}

export const COLLABORATION_ORIGIN = resolveCollaborationOrigin()
