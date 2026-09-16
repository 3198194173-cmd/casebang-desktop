import type { BaseFileUpdateRecord } from '@shared/contracts'

export interface BaseFileHistoryGroup {
  id: string
  name: string
  createdAt: string
  records: BaseFileUpdateRecord[]
}

export function groupUpdateHistory(records: BaseFileUpdateRecord[]): BaseFileHistoryGroup[] {
  const groups = new Map<string, BaseFileHistoryGroup>()
  for (const record of records) {
    if (isRollbackSafetyRecord(record)) continue
    const name = record.operationName ?? record.taskName
    const id = record.batchId ?? `legacy:${name}:${record.createdAt.slice(0, 16)}`
    const group = groups.get(id) ?? { id, name, createdAt: record.createdAt, records: [] }
    group.records.push(record)
    if (record.createdAt > group.createdAt) group.createdAt = record.createdAt
    groups.set(id, group)
  }
  return [...groups.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function isRollbackSafetyRecord(record: BaseFileUpdateRecord): boolean {
  return record.historyRole === 'rollback-safety'
    || record.operationName?.startsWith('回滚前自动备份：') === true
    || record.taskName.startsWith('回滚前自动备份：')
}
