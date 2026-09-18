import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('same-host reverse-proxy deployment', () => {
  it('keeps /AI/ isolated and strips only the /collab/ prefix', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const snippet = await readFile(resolve(root, 'deploy/nginx/casebang.tech-collab.location.example'), 'utf8')
    const environment = await readFile(resolve(root, 'deploy/collaboration.env.example'), 'utf8')

    expect(environment).toContain('PUBLIC_ORIGIN=https://casebang.tech/collab')
    expect(environment).toContain('WPS_APP_ID=SX20260918QZNBYG')
    expect(environment).toContain('WPS_WEBOFFICE_ENABLED=false')
    expect(snippet).toContain('location /collab/')
    expect(snippet).toContain('proxy_pass http://127.0.0.1:3100/;')
    expect(snippet).toContain('X-Forwarded-Prefix /collab')
    expect(snippet).not.toContain('location /AI/')
    expect(snippet).not.toContain('server_name collab.casebang.tech')
  })
})
