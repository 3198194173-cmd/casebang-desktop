import { DatabaseSync } from 'node:sqlite'
import type { LifecycleDraft, LifecycleDraftSummary, BarcodeSource } from '../../../shared/lifecycle-contracts'

/** Local preparation only. This is not the shared number ledger or an identity provider. */
export class LifecycleRepository {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lifecycle_drafts (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_draft_events (id INTEGER PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES lifecycle_drafts(id), version INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(draft_id,version));`)
  }
  close(): void { this.db.close() }
  findByHash(hash: string): LifecycleDraft | null {
    const row = this.db.prepare('SELECT document FROM lifecycle_drafts WHERE hash=?').get(hash) as { document: string } | undefined
    return row ? JSON.parse(row.document) as LifecycleDraft : null
  }
  get(id: string): LifecycleDraft {
    const row = this.db.prepare('SELECT document FROM lifecycle_drafts WHERE id=?').get(id) as { document: string } | undefined
    if (!row) throw new Error('本地建档草稿不存在')
    return JSON.parse(row.document) as LifecycleDraft
  }
  list(): LifecycleDraftSummary[] {
    return this.db.prepare('SELECT document FROM lifecycle_drafts ORDER BY rowid DESC').all().map(value => {
      const draft = JSON.parse(value.document as string) as LifecycleDraft
      return { id: draft.id, title: draft.title, source: draft.source, createdAt: draft.createdAt, version: draft.version,
        rowCount: draft.rows.length, issueCount: draft.rows.filter(row => row.issues.length).length }
    })
  }
  insert(draft: LifecycleDraft): LifecycleDraft {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.findByHash(draft.sourceHash)
      if (prior) { this.db.exec('COMMIT'); return prior }
      this.db.prepare('INSERT INTO lifecycle_drafts VALUES(?,?,?,?)').run(draft.id, draft.sourceHash, draft.version, JSON.stringify(draft))
      this.event(draft, 'import')
      this.db.exec('COMMIT'); return draft
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  save(id: string, expectedVersion: number, barcodeSource: BarcodeSource | null, patternVariants: Record<string, string>): LifecycleDraft {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const draft = this.get(id)
      if (draft.version !== expectedVersion) throw new Error('草稿已更新，请重新打开后再保存；旧版本不会覆盖新版本')
      const next = { ...draft, version: draft.version + 1, barcodeSource, patternVariants }
      this.db.prepare('UPDATE lifecycle_drafts SET version=?,document=? WHERE id=? AND version=?').run(next.version, JSON.stringify(next), id, expectedVersion)
      this.event(next, 'save-preparation'); this.db.exec('COMMIT'); return next
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private event(draft: LifecycleDraft, action: string): void {
    this.db.prepare('INSERT INTO lifecycle_draft_events(draft_id,version,action,created_at) VALUES(?,?,?,?)').run(draft.id, draft.version, action, new Date().toISOString())
  }
}
