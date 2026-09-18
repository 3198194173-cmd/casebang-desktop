export type WorkState = 'DRAFT' | 'PENDING_PROCESSING' | 'PROCESSING' | 'NEEDS_SOURCE_FIX' | 'PENDING_ORIGIN_REVIEW' | 'REVISION_REQUESTED' | 'READY_TO_MERGE' | 'MERGED_PENDING_SYNC' | 'SYNCING' | 'SYNC_FAILED' | 'COMPLETED' | 'CANCELLED'
export interface WorkItemState { tenantId: string; originId: string; assigneeId: string; state: WorkState; version: number; revision: number }
export type WorkAction = 'submit' | 'claim' | 'return-source' | 'return-origin' | 'request-changes' | 'approve' | 'merge' | 'start-sync' | 'sync-failed' | 'sync-verified'
/** Server-side domain guard. Actor/evidence must come from verified server records, never renderer flags. */
export function transitionWorkItem(item: WorkItemState, input: {
  tenantId: string; actorId: string; expectedVersion: number; revision: number; action: WorkAction; reason?: string
}, evidence: { fileVerified?: boolean; codesVerified?: boolean; artworkVerified?: boolean; masterVersionVerified?: boolean; remoteReadbackVerified?: boolean; serviceActor?: boolean }): WorkItemState {
  if (input.tenantId !== item.tenantId) throw new Error('企业范围不匹配')
  if (input.expectedVersion !== item.version || input.revision !== item.revision) throw new Error('版本冲突，请刷新任务')
  const rules: Record<WorkAction, { from: WorkState[]; to: WorkState; actor: 'origin' | 'assignee' | 'service' }> = {
    submit: { from: ['DRAFT', 'NEEDS_SOURCE_FIX'], to: 'PENDING_PROCESSING', actor: 'origin' },
    claim: { from: ['PENDING_PROCESSING', 'REVISION_REQUESTED'], to: 'PROCESSING', actor: 'assignee' },
    'return-source': { from: ['PROCESSING'], to: 'NEEDS_SOURCE_FIX', actor: 'assignee' },
    'return-origin': { from: ['PROCESSING'], to: 'PENDING_ORIGIN_REVIEW', actor: 'assignee' },
    'request-changes': { from: ['PENDING_ORIGIN_REVIEW'], to: 'REVISION_REQUESTED', actor: 'origin' },
    approve: { from: ['PENDING_ORIGIN_REVIEW'], to: 'READY_TO_MERGE', actor: 'origin' },
    merge: { from: ['READY_TO_MERGE'], to: 'MERGED_PENDING_SYNC', actor: 'origin' },
    'start-sync': { from: ['MERGED_PENDING_SYNC', 'SYNC_FAILED'], to: 'SYNCING', actor: 'origin' },
    'sync-failed': { from: ['SYNCING'], to: 'SYNC_FAILED', actor: 'service' },
    'sync-verified': { from: ['SYNCING'], to: 'COMPLETED', actor: 'service' }
  }
  const rule = rules[input.action]
  if (!rule.from.includes(item.state)) throw new Error('当前状态不允许该操作')
  if (rule.actor === 'service' ? !evidence.serviceActor : input.actorId !== (rule.actor === 'origin' ? item.originId : item.assigneeId)) throw new Error('不是当前步骤的责任人')
  if (['return-source', 'request-changes'].includes(input.action) && !input.reason?.trim()) throw new Error('退回必须填写原因')
  if (input.action === 'submit' && !evidence.fileVerified) throw new Error('工作簿版本尚未核验')
  if (['return-origin', 'approve'].includes(input.action) && !(evidence.codesVerified && evidence.artworkVerified)) throw new Error('编码或图档仍有未通过的物料行')
  if (input.action === 'merge' && !evidence.masterVersionVerified) throw new Error('总表版本未核验')
  if (input.action === 'sync-verified' && !evidence.remoteReadbackVerified) throw new Error('在线表格尚未回读核验，不能标记完成')
  return { ...item, state: rule.to, version: item.version + 1 }
}
