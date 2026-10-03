import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export type RequestRecord = {
  id: string; client_id: string; route_id: string; idem_key: string; body_hash: string;
  state: string; attempts: number; upstream_status: number | null; created_at: string; updated_at: string
}

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, route_id TEXT NOT NULL,
        idem_key TEXT NOT NULL, body_hash TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, upstream_status INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(client_id, route_id, idem_key)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
        client_id TEXT, route_id TEXT, request_id TEXT, status INTEGER, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_recent ON audit(id DESC);
    `)
  }

  getByKey(clientId: string, routeId: string, key: string): RequestRecord | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE client_id=? AND route_id=? AND idem_key=?').get(clientId, routeId, key) as RequestRecord | undefined
  }

  create(clientId: string, routeId: string, key: string, hash: string): RequestRecord {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT OR IGNORE INTO requests (id,client_id,route_id,idem_key,body_hash,state,created_at,updated_at)
      VALUES (?,?,?,?,?,'processing',?,?)`).run(randomUUID(), clientId, routeId, key, hash, now, now)
    return this.getByKey(clientId, routeId, key)!
  }

  attempt(id: string, number: number, status: number, detail: string): void {
    this.db.prepare('UPDATE requests SET attempts=?, upstream_status=?, updated_at=? WHERE id=?').run(number, status || null, new Date().toISOString(), id)
    const row = this.getRequest(id)!
    this.audit('attempt', detail, { requestId: id, clientId: row.client_id, routeId: row.route_id, status })
  }

  finish(id: string, state: 'completed' | 'rejected' | 'failed', status: number | null): void {
    this.db.prepare('UPDATE requests SET state=?,upstream_status=?,updated_at=? WHERE id=?').run(state, status, new Date().toISOString(), id)
    const row = this.getRequest(id)!
    this.audit(state, 'Delivery state changed', { requestId: id, clientId: row.client_id, routeId: row.route_id, status: status || 0 })
  }

  retry(id: string): void {
    this.db.prepare("UPDATE requests SET state='processing', updated_at=? WHERE id=?").run(new Date().toISOString(), id)
    const row = this.getRequest(id)!
    this.audit('retry', 'Same idempotency key retried', { requestId: id, clientId: row.client_id, routeId: row.route_id })
  }

  audit(kind: string, detail: string, refs: { clientId?: string; routeId?: string; requestId?: string; status?: number } = {}): void {
    this.db.prepare('INSERT INTO audit (at,kind,client_id,route_id,request_id,status,detail) VALUES (?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), kind, refs.clientId || null, refs.routeId || null, refs.requestId || null, refs.status || null, detail.slice(0, 180))
  }

  getRequest(id: string): RequestRecord | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as RequestRecord | undefined
  }

  recentAudit(limit: number): Array<Record<string, unknown>> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50
    return this.db.prepare('SELECT id,at,kind,client_id,route_id,request_id,status,detail FROM audit ORDER BY id DESC LIMIT ?')
      .all(bounded) as Array<Record<string, unknown>>
  }

  close(): void { this.db.close() }
}
