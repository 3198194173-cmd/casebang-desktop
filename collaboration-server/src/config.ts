import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const booleanValue = z.string().optional().transform(value => value === 'true' || value === '1')
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  PUBLIC_ORIGIN: z.string().url(),
  STORAGE_ROOT: z.string().min(1).default('/data/workbooks'),
  MIGRATIONS_ROOT: z.string().optional(),
  DB_HOST: z.string().min(1).default('postgres'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1).default('casebang_collab'),
  DB_USER: z.string().min(1).default('casebang'),
  DB_PASSWORD: z.string().optional(),
  DB_PASSWORD_FILE: z.string().optional(),
  DB_SSL: booleanValue,
  DINGTALK_STREAM_ENABLED: booleanValue,
  DINGTALK_CORP_ID: z.string().optional(),
  DINGTALK_CLIENT_ID: z.string().optional(),
  DINGTALK_AGENT_ID: z.string().optional(),
  DINGTALK_CLIENT_SECRET: z.string().optional(),
  DINGTALK_CLIENT_SECRET_FILE: z.string().optional()
}).passthrough()

export interface ServerConfig {
  environment: 'development' | 'test' | 'production'
  host: string
  port: number
  publicOrigin: string
  storageRoot: string
  migrationsRoot: string
  database: { host: string; port: number; name: string; user: string; password: string; ssl: boolean }
  dingtalk: { enabled: boolean; corpId: string; clientId: string; agentId: string; clientSecret: string }
}

function secret(name: string, direct: string | undefined, file: string | undefined, production: boolean): string {
  if (production && direct) throw new Error(`${name} 生产环境必须通过 *_FILE 提供，禁止直接写入容器环境变量`)
  const value = file ? readFileSync(file, 'utf8').trim() : direct?.trim() ?? ''
  if (!value) throw new Error(`${name} 未配置`)
  return value
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const value = environmentSchema.parse(environment)
  const production = value.NODE_ENV === 'production'
  if (production && !value.PUBLIC_ORIGIN.startsWith('https://')) throw new Error('生产环境 PUBLIC_ORIGIN 必须使用 HTTPS')
  const storageRoot = resolve(value.STORAGE_ROOT)
  if (!isAbsolute(storageRoot)) throw new Error('STORAGE_ROOT 必须是绝对路径')
  const here = dirname(fileURLToPath(import.meta.url))
  const databasePassword = secret('DB_PASSWORD', value.DB_PASSWORD, value.DB_PASSWORD_FILE, production)
  const dingtalkRequired = value.DINGTALK_STREAM_ENABLED
  const dingtalkClientSecret = dingtalkRequired
    ? secret('DINGTALK_CLIENT_SECRET', value.DINGTALK_CLIENT_SECRET, value.DINGTALK_CLIENT_SECRET_FILE, production)
    : ''
  if (dingtalkRequired && !(value.DINGTALK_CORP_ID && value.DINGTALK_CLIENT_ID && value.DINGTALK_AGENT_ID)) {
    throw new Error('启用钉钉 Stream 时必须配置 CorpId、ClientId 和 AgentId')
  }
  return {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    publicOrigin: value.PUBLIC_ORIGIN.replace(/\/$/, ''),
    storageRoot,
    migrationsRoot: resolve(value.MIGRATIONS_ROOT ?? resolve(here, '../migrations')),
    database: { host: value.DB_HOST, port: value.DB_PORT, name: value.DB_NAME, user: value.DB_USER, password: databasePassword, ssl: value.DB_SSL },
    dingtalk: {
      enabled: dingtalkRequired,
      corpId: value.DINGTALK_CORP_ID ?? '',
      clientId: value.DINGTALK_CLIENT_ID ?? '',
      agentId: value.DINGTALK_AGENT_ID ?? '',
      clientSecret: dingtalkClientSecret
    }
  }
}
