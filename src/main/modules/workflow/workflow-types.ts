export type WorkflowStepId =
  | 'prepare-workbooks'
  | 'segment-image'
  | 'group-patterns'
  | 'confirm-names'
  | 'allocate-codes'
  | 'generate-workbooks'
  | 'quality-check'
  | 'share-outputs'

export type WorkflowStepStatus = 'pending' | 'running' | 'needs-review' | 'completed' | 'failed'

export interface WorkflowStepState {
  id: WorkflowStepId
  status: WorkflowStepStatus
  progress: number
  message: string | null
}

export interface WorkflowJobState {
  taskId: string
  steps: WorkflowStepState[]
  createdAt: string
  updatedAt: string
}
