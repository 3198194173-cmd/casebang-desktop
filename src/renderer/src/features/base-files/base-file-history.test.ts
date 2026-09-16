import { describe, expect, it } from 'vitest'
import type { BaseFileUpdateRecord } from '@shared/contracts'
import { groupUpdateHistory } from './base-file-history'

const overwrite = (overrides: Partial<BaseFileUpdateRecord>): BaseFileUpdateRecord => ({
  id: 'record',
  batchId: 'batch-1',
  historyRole: 'overwrite',
  kind: 'barcodeReference',
  taskName: 'Cats Series#K1系列-表格更新.xlsx',
  operationName: 'Cats Series#K1系列-表格更新.xlsx',
  sourcePath: 'A.xlsx',
  sourceFileName: 'A.xlsx',
  backupPath: 'backup.xlsx',
  createdAt: '2026-09-03T03:00:00.000Z',
  rolledBackAt: null,
  ...overrides
})

describe('groupUpdateHistory', () => {
  it('keeps two table rollbacks inside one original operation', () => {
    const records = [
      overwrite({ id: 'a', rolledBackAt: '2026-09-03T04:00:00.000Z' }),
      overwrite({ id: 'b', kind: 'domesticNaming', rolledBackAt: '2026-09-03T04:01:00.000Z' }),
      overwrite({ id: 'safe-a', historyRole: 'rollback-safety', parentRecordId: 'a' }),
      overwrite({ id: 'safe-b', historyRole: 'rollback-safety', parentRecordId: 'b', kind: 'domesticNaming' })
    ]

    const groups = groupUpdateHistory(records)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.records.map((record) => record.id)).toEqual(['a', 'b'])
    expect(groups[0]!.records.every((record) => record.rolledBackAt)).toBe(true)
  })

  it('hides legacy rollback backups that previously appeared as separate groups', () => {
    const records = [
      overwrite({ id: 'a' }),
      overwrite({ id: 'legacy', batchId: 'legacy-batch', historyRole: undefined, operationName: '回滚前自动备份：Cats Series#K1系列-表格更新.xlsx' })
    ]

    expect(groupUpdateHistory(records)).toHaveLength(1)
  })
})
