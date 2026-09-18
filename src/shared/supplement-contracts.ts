export interface SupplementRequest { masterPath: string; inputPath: string; targetModel: string }
export interface SupplementRow {
  source: string; batch: string; series: string; original: string; model: string; variant: string
  status: 'matched' | 'missing' | 'conflict'; reason: string; reference: string; values: string[]
}
export interface SupplementResult { rows: SupplementRow[]; matched: number; missing: number; conflict: number }
export interface SupplementVariantOverride { variant: string; domesticPrice?: string; overseasPrice?: string; material?: string }
export interface SupplementOverrides { domesticPrice?: string; overseasPrice?: string; material?: string; variants?: SupplementVariantOverride[]; draft?: { result: SupplementResult; sourcePaths: string[] } }
export interface SupplementApi {
  getMaster(): Promise<string | null>
  selectMaster(): Promise<string | null>
  select(): Promise<string | null>
  analyze(input: SupplementRequest): Promise<SupplementResult>
  export(input?: SupplementOverrides): Promise<string | null>
  publishShared(input: { title: string; overrides: SupplementOverrides }): Promise<{ item: import('./contracts').CollaborationWorkItem; duplicate: boolean }>
}
