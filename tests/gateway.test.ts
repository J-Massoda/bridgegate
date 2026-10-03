import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { createDemoSink } from '../src/demo-sink.js'
import { createGatewayServer, validateConfig } from '../src/http.js'
import type { GatewayConfig } from '../src/types.js'

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert(addr && typeof addr !== 'string')
  return addr.port
}
async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())) }
const body = JSON.stringify({ type: 'order.updated', data: { reference: 'FICTIONAL-1042' } })
const clientKey = 'test-client-secret-123456'
const adminKey = 'test-admin-secret-123456'
const secret = 'test-signing-secret-123456'
const headers = { Authorization: `Bearer ${clientKey}`, 'Idempotency-Key': 'order-1042', 'Content-Type': 'application/json' }
function config(url: string, dbPath: string, extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return { clients: { 'test-client': clientKey }, adminKey, routes: { orders: { id: 'orders', url, secret } },
    dbPath, rateLimit: 10, rateWindowMs: 60_000, maxAttempts: 3, timeoutMs: 500,
    retryDelayMs: 5, circuitThreshold: 2, circuitCooldownMs: 1_000, ...extra }
}

test('signed retry, replay, conflict and redacted audit', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gate-test-'))
  const sink = createDemoSink(secret)
  const sinkPort = await listen(sink.server)
  const gateway = createGatewayServer(config(`http://127.0.0.1:${sinkPort}/receiver`, join(folder, 'db.sqlite3')))
  const port = await listen(gateway.server)
  try {
    const url = `http://127.0.0.1:${port}`
    const first = await fetch(url + '/v1/forward/orders', { method: 'POST', headers, body })
    assert.equal(first.status, 200)
    const result = await first.json() as { state: string; attempts: number; requestId: string }
    assert.equal(result.state, 'completed')
    assert.equal(result.attempts, 2)
    assert.equal(sink.counts.get('order-1042'), 2)
    const replay = await fetch(url + '/v1/forward/orders', { method: 'POST', headers, body }).then(r => r.json()) as { replayed: boolean }
    assert.equal(replay.replayed, true)
    assert.equal(sink.counts.get('order-1042'), 2)
    const conflict = await fetch(url + '/v1/forward/orders', { method: 'POST', headers, body: JSON.stringify({ type: 'order.updated', data: { reference: 'CHANGED' } }) })
    assert.equal(conflict.status, 409)
    assert.equal((await fetch(url + '/v1/requests/' + result.requestId)).status, 401)
    const record = await fetch(url + '/v1/requests/' + result.requestId, { headers: { Authorization: `Bearer ${adminKey}` } }).then(r => r.json()) as Record<string, unknown>
    assert.equal(record.state, 'completed')
    assert.equal(record.body_hash, undefined)
    const audit = await fetch(url + '/v1/audit', { headers: { Authorization: `Bearer ${adminKey}` } }).then(r => r.text())
    assert(audit.includes('idempotency_conflict'))
    assert(!audit.includes(clientKey) && !audit.includes(secret) && !audit.includes('FICTIONAL-1042'))
  } finally { await close(gateway.server); gateway.gateway.close(); await close(sink.server); rmSync(folder, { recursive: true, force: true }) }
})

test('rejects unauthorized, malformed, oversized and rate-limited traffic', async () => {
  const sink = createServer((_req, res) => { res.writeHead(200); res.end() })
  const port = await listen(sink)
  const gateway = createGatewayServer(config(`http://127.0.0.1:${port}/`, ':memory:', { rateLimit: 3 }))
  const gatewayPort = await listen(gateway.server)
  const url = `http://127.0.0.1:${gatewayPort}/v1/forward/orders`
  try {
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401)
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body })).status, 415)
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{bad' })).status, 400)
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ type: 'order.updated', data: { content: 'x'.repeat(66_000) } }) })).status, 413)
    const limited = await fetch(url, { method: 'POST', headers, body })
    assert.equal(limited.status, 429)
    assert(Number(limited.headers.get('Retry-After')) >= 1)
    assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/v1/audit`)).status, 401)
  } finally { await close(gateway.server); gateway.gateway.close(); await close(sink) }
  const invalid = config('http://example.com/receiver', ':memory:')
  assert.throws(() => validateConfig(invalid), /fixed HTTPS/)
  assert.throws(() => validateConfig(config('https://example.com/events', ':memory:', { adminKey: clientKey })), /must differ/)
})

test('single-flight duplicate delivery, persistence and circuit breaker', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gate-persist-'))
  let calls = 0
  let failing = false
  const sink = createServer(async (_req, res) => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); res.writeHead(failing ? 503 : 200); res.end() })
  const sinkPort = await listen(sink)
  const dbPath = join(folder, 'db.sqlite3')
  const gatewayConfig = config(`http://127.0.0.1:${sinkPort}/`, dbPath, { maxAttempts: 2, circuitThreshold: 2 })
  let gateway = createGatewayServer(gatewayConfig)
  let port = await listen(gateway.server)
  try {
    const url = `http://127.0.0.1:${port}/v1/forward/orders`
    const requests = await Promise.all([fetch(url, { method: 'POST', headers, body }), fetch(url, { method: 'POST', headers, body })])
    assert.deepEqual(requests.map(r => r.status), [200, 200])
    assert.equal(calls, 1)
    await close(gateway.server); gateway.gateway.close()
    gateway = createGatewayServer(gatewayConfig)
    port = await listen(gateway.server)
    const replay = await fetch(`http://127.0.0.1:${port}/v1/forward/orders`, { method: 'POST', headers, body }).then(r => r.json()) as { replayed: boolean }
    assert.equal(replay.replayed, true)
    assert.equal(calls, 1)
    failing = true
    for (const key of ['failure-0001', 'failure-0002']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/forward/orders`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body })
      assert.equal(response.status, 503)
    }
    assert.equal(calls, 5)
    const paused = await fetch(`http://127.0.0.1:${port}/v1/forward/orders`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'failure-0003' }, body })
    assert.equal(paused.status, 503)
    assert.equal((await paused.json() as { state: string }).state, 'paused')
    assert.equal(calls, 5)
  } finally { await close(gateway.server); gateway.gateway.close(); await close(sink); rmSync(folder, { recursive: true, force: true }) }
})
