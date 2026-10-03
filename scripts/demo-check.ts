import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDemoSink } from '../src/demo-sink.js'
import { createGatewayServer } from '../src/http.js'
import type { Server } from 'node:http'
import type { GatewayConfig } from '../src/types.js'

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('No local port')
  return addr.port
}
async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())) }

const folder = mkdtempSync(join(tmpdir(), 'bridgegate-demo-'))
const secret = 'local-signing-key-for-demo'
const sink = createDemoSink(secret)
let gateway: ReturnType<typeof createGatewayServer> | null = null
try {
  const sinkPort = await listen(sink.server)
  const config: GatewayConfig = {
    clients: { 'demo-client': 'local-demo-key-change-me' }, adminKey: 'local-admin-key-change-me',
    routes: { orders: { id: 'orders', url: `http://127.0.0.1:${sinkPort}/receiver`, secret } },
    dbPath: join(folder, 'audit.sqlite3'), rateLimit: 10, rateWindowMs: 60_000,
    maxAttempts: 3, timeoutMs: 2_000, retryDelayMs: 50, circuitThreshold: 3, circuitCooldownMs: 10_000, demo: true
  }
  gateway = createGatewayServer(config)
  const port = await listen(gateway.server)
  const url = `http://127.0.0.1:${port}`
  const options = { method: 'POST', headers: { Authorization: 'Bearer local-demo-key-change-me',
    'Idempotency-Key': 'demo-order-1042', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'order.updated', data: { reference: 'FICTIONAL-1042' } }) }
  const first = await fetch(url + '/v1/forward/orders', options).then(response => response.json()) as { state: string; attempts: number; requestId: string }
  const replay = await fetch(url + '/v1/forward/orders', options).then(response => response.json()) as { replayed: boolean }
  const audit = await fetch(url + '/v1/audit', { headers: { Authorization: 'Bearer local-admin-key-change-me' } }).then(response => response.json()) as { events: unknown[] }
  if (first.state !== 'completed' || first.attempts !== 2 || !replay.replayed || sink.counts.get('demo-order-1042') !== 2) throw new Error('Retry or replay check failed.')
  console.log(`Forwarded fictional order: first receiver response 503, second 200. Gateway state: ${first.state}.`)
  console.log(`Same key returned a stored result without another delivery. Audit entries: ${audit.events.length}. Request: ${first.requestId}.`)
} finally {
  if (gateway) { await close(gateway.server); gateway.gateway.close() }
  await close(sink.server)
  rmSync(folder, { recursive: true, force: true })
}
