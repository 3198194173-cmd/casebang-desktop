import { describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from '../src/config.js'
import { DingTalkDriveClient } from '../src/dingtalk-drive.js'

const config = {
  dingtalk: { clientId: 'app-key', clientSecret: 'secret', enabled: true, corpId: 'corp', agentId: 'agent' }
} as ServerConfig

describe('personal DingTalk artwork drive', () => {
  it('resolves an alidocs node inside the currently authenticated user personal space without downloading files', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth2/accessToken')) return Response.json({ accessToken: 'app-token' })
      if (url.includes('/v1.0/drive/spaces?')) {
        expect(url).toContain('unionId=union-1')
        expect(url).toMatch(/spaceType=(personal|org)/)
        return Response.json({ spaces: [{ spaceId: 'personal-space' }] })
      }
      if (url.includes('/dentries/listAll')) return Response.json({ dentries: [
        { id: 'folder-id', uuid: 'folder-node-from-url', parentId: '0', name: '印刷图档', type: 'FOLDER', path: '/印刷图档' },
        { id: 'child-folder', parentId: 'folder-id', name: 'J7系列', type: 'FOLDER', path: '/印刷图档/J7系列' },
        { id: 'image-id', parentId: 'child-folder', name: 'Heart Hat Cat.png', type: 'FILE', extension: 'png', size: 2048, version: 3 }
      ] })
      return new Response(null, { status: 404 })
    })
    const client = new DingTalkDriveClient(config, fetcher as typeof fetch)

    const result = await client.resolvePersonalFolder('union-1', 'folder-node-from-url')

    expect(result.spaceId).toBe('personal-space')
    expect(result.folder.name).toBe('印刷图档')
    expect(result.descendants.map(entry => entry.name)).toEqual(['J7系列', 'Heart Hat Cat.png'])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('falls back to recursively listing folders when listAll is unavailable', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth2/accessToken')) return Response.json({ accessToken: 'app-token' })
      if (url.includes('/v1.0/drive/spaces?')) return Response.json({ spaces: [{ spaceId: 'personal-space' }] })
      if (url.includes('/dentries/listAll')) return Response.json({ code: 'unsupported.operation', message: 'not enabled' }, { status: 500 })
      if (url.includes('parentId=0')) return Response.json({ dentries: [
        { id: 'folder-id', uuid: 'folder-node-from-url', parentId: '0', name: '印刷图档', type: 'FOLDER' }
      ] })
      if (url.includes('parentId=folder-id')) return Response.json({ dentries: [
        { id: 'image-id', parentId: 'folder-id', name: 'Heart Hat Cat.png', type: 'FILE', extension: 'png' }
      ] })
      return new Response(null, { status: 404 })
    })
    const client = new DingTalkDriveClient(config, fetcher as typeof fetch)

    const result = await client.resolvePersonalFolder('union-1', 'folder-node-from-url')

    expect(result.descendants.map(entry => entry.name)).toEqual(['Heart Hat Cat.png'])
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('uses an organization drive when personal space access is denied', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth2/accessToken')) return Response.json({ accessToken: 'app-token' })
      if (url.includes('spaceType=personal')) return Response.json({ code: 'no.priviledge', message: 'not authorized' }, { status: 400 })
      if (url.includes('spaceType=org')) return Response.json({ spaces: [{ spaceId: 'org-space' }] })
      if (url.includes('/dentries/listAll')) return Response.json({ dentries: [
        { id: 'folder-id', uuid: 'org-folder-node', parentId: '0', name: '印刷图档', type: 'FOLDER' },
        { id: 'image-id', parentId: 'folder-id', name: 'Heart Hat Cat.png', type: 'FILE', extension: 'png' }
      ] })
      return new Response(null, { status: 404 })
    })
    const client = new DingTalkDriveClient(config, fetcher as typeof fetch)

    const result = await client.resolvePersonalFolder('union-1', 'org-folder-node')

    expect(result.spaceId).toBe('org-space')
    expect(result.folder.name).toBe('印刷图档')
    expect(result.descendants.map(entry => entry.name)).toEqual(['Heart Hat Cat.png'])
  })

  it('classifies alternate DingTalk permission errors', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth2/accessToken')) return Response.json({ accessToken: 'app-token' })
      return Response.json({ code: 'Forbidden.AccessDenied', message: 'permission denied' }, { status: 403 })
    })
    const client = new DingTalkDriveClient(config, fetcher as typeof fetch)

    await expect(client.resolvePersonalFolder('union-1', 'folder-node-from-url')).rejects.toMatchObject({
      code: 'dingtalk_drive_permission_denied',
      details: { operation: 'list_org_spaces', httpStatus: 403, remoteCode: 'Forbidden.AccessDenied' }
    })
  })
})
