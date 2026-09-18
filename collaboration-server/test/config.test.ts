import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.js'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('central service configuration', () => {
  it('loads development secrets without enabling DingTalk implicitly', () => {
    const value = loadConfig({ PUBLIC_ORIGIN: 'http://localhost:3100', DB_PASSWORD: 'test-password', NODE_ENV: 'test', STORAGE_ROOT: './tmp-test' })
    expect(value.database.password).toBe('test-password')
    expect(value.dingtalk.enabled).toBe(false)
    expect(value.dingtalk.clientSecret).toBe('')
    expect(value.storageRoot).toMatch(/tmp-test$/)
  })
  it('requires HTTPS and secret files in production', async () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'http://collab.example.com', DB_PASSWORD: 'x', NODE_ENV: 'production' })).toThrow('HTTPS')
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://collab.example.com', DB_PASSWORD: 'x', NODE_ENV: 'production' })).toThrow('必须通过')
    const folder = await mkdtemp(join(tmpdir(), 'casebang-config-')); temporary.push(folder)
    const databaseFile = join(folder, 'db'); await writeFile(databaseFile, 'database-secret\n')
    const dingFile = join(folder, 'ding'); await writeFile(dingFile, 'dingtalk-secret\n')
    const value = loadConfig({
      PUBLIC_ORIGIN: 'https://collab.example.com', NODE_ENV: 'production', STORAGE_ROOT: join(folder, 'store'),
      DB_PASSWORD_FILE: databaseFile, DINGTALK_STREAM_ENABLED: 'true', DINGTALK_CLIENT_SECRET_FILE: dingFile,
      DINGTALK_CORP_ID: 'ding-corp', DINGTALK_CLIENT_ID: 'ding-client', DINGTALK_AGENT_ID: '123'
    })
    expect(value.database.password).toBe('database-secret')
    expect(value.dingtalk).toMatchObject({ enabled: true, corpId: 'ding-corp', clientId: 'ding-client', agentId: '123', clientSecret: 'dingtalk-secret' })
  })
  it('refuses an incomplete DingTalk Stream configuration', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'http://localhost', DB_PASSWORD: 'x', DINGTALK_STREAM_ENABLED: 'true', DINGTALK_CLIENT_SECRET: 'y' })).toThrow('CorpId')
  })

  it('loads WPS WebOffice identifiers only when its secret is configured', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://casebang.tech/collab', DB_PASSWORD: 'x',
      WPS_WEBOFFICE_ENABLED: 'true', WPS_APP_ID: 'SX20260918QZNBYG'
    })).toThrow('WPS_APP_SECRET')
    const value = loadConfig({
      NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://casebang.tech/collab', DB_PASSWORD: 'x',
      WPS_WEBOFFICE_ENABLED: 'true', WPS_APP_ID: 'SX20260918QZNBYG', WPS_APP_SECRET: 'test-wps-secret'
    })
    expect(value.wps).toEqual({ enabled: true, appId: 'SX20260918QZNBYG', appSecret: 'test-wps-secret' })
  })
  it('preserves and normalizes the public reverse-proxy path prefix', () => {
    const value = loadConfig({
      NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://casebang.tech/collab/',
      DB_PASSWORD: 'test-password', STORAGE_ROOT: './tmp-test'
    })
    expect(value.publicOrigin).toBe('https://casebang.tech/collab')
  })
})
