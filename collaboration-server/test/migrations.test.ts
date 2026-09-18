import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('database migration files', () => {
  it('are ordered, transaction-runner compatible, and contain the central ledger safeguards', async () => {
    const root = resolve(import.meta.dirname, '../migrations')
    const names = (await readdir(root)).filter(name => name.endsWith('.sql')).sort()
    expect(names).toEqual(['001_foundation.sql', '002_stream_events.sql', '003_dingtalk_auth.sql', '004_business_roles.sql', '005_weboffice.sql', '006_relaxed_workbook_participants.sql'])
    const sql = (await Promise.all(names.map(name => readFile(resolve(root, name), 'utf8')))).join('\n')
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/m)
    expect(sql).toContain('UNIQUE(organization_id,kind,code)')
    expect(sql).toContain('one_live_code_per_sku')
    expect(sql).toContain('UNIQUE(organization_id,request_key)')
    expect(sql).toContain('event_id text NOT NULL UNIQUE')
    expect(sql).toContain('CREATE TABLE auth_attempts')
    expect(sql).toContain('CREATE TABLE user_sessions')
    expect(sql).toContain('token_hash text NOT NULL UNIQUE')
    expect(sql).toContain("CHECK(business_role IN ('upstream','downstream'))")
    expect(sql).toContain("CHECK(requested_business_role IN ('upstream','downstream'))")
    expect(sql).toContain('May equal origin_id for single-account testing')
  })
})
