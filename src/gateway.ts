import { Store } from './store.js'
import { bodyHash, signRequest } from './security.js'
import type { GatewayConfig, Result } from './types.js'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class Gateway {
  readonly store: Store
  private inFlight = new Map<string, Promise<Result>>()
  private hits = new Map<string, number[]>()
  private failures = new Map<string, { count: number; openUntil: number }>()

  constructor(readonly config: GatewayConfig) {
    this.store = new Store(config.dbPath)
  }

  rate(clientId: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    const hits = (this.hits.get(clientId) || []).filter(at => at > now - this.config.rateWindowMs)
    if (hits.length >= this.config.rateLimit) {
      this.hits.set(clientId, hits)
      const retryAfter = Math.max(1, Math.ceil((hits[0]! + this.config.rateWindowMs - now) / 1000))
      this.store.audit('rate_limited', 'Client request limit reached', { clientId, status: 429 })
      return { allowed: false, retryAfter }
    }
    hits.push(now)
    this.hits.set(clientId, hits)
    return { allowed: true, retryAfter: 0 }
  }

  async submit(clientId: string, routeId: string, key: string, raw: string): Promise<Result> {
    const route = this.config.routes[routeId]
    if (!route) return { status: 404, body: { requestId: '', route: routeId, attempts: 0, state: 'rejected', message: 'Unknown fixed route.' } }
    const hash = bodyHash(raw)
    const compound = JSON.stringify([clientId, routeId, key])
    let record = this.store.getByKey(clientId, routeId, key)
    if (record && record.body_hash !== hash) {
      this.store.audit('idempotency_conflict', 'Same key with different body', { clientId, routeId, requestId: record.id, status: 409 })
      return { status: 409, body: { requestId: record.id, route: routeId, attempts: record.attempts, state: 'conflict', message: 'Idempotency key already used for different content.' } }
    }
    if (record && (record.state === 'completed' || record.state === 'rejected')) {
      this.store.audit('replayed', 'Stored result returned without forwarding', { clientId, routeId, requestId: record.id })
      return { status: record.state === 'completed' ? 200 : 502, body: {
        requestId: record.id, route: routeId, attempts: record.attempts, state: record.state,
        upstreamStatus: record.upstream_status || undefined, message: 'Stored result returned; no new delivery.', replayed: true
      } }
    }
    const active = this.inFlight.get(compound)
    if (active) return active
    if (!record) record = this.store.create(clientId, routeId, key, hash)
    else this.store.retry(record.id) // safe only when the receiver deduplicates the same key
    const task = this.deliver(record.id, clientId, routeId, key, raw)
    this.inFlight.set(compound, task)
    try { return await task } finally { this.inFlight.delete(compound) }
  }

  private async deliver(requestId: string, clientId: string, routeId: string, key: string, raw: string): Promise<Result> {
    const route = this.config.routes[routeId]!
    const breaker = this.failures.get(routeId)
    if (breaker && breaker.openUntil > Date.now()) {
      this.store.audit('circuit_open', 'Route temporarily paused after repeated failures', { clientId, routeId, requestId, status: 503 })
      this.store.finish(requestId, 'failed', null)
      return { status: 503, body: { requestId, route: routeId, state: 'paused', attempts: this.store.getRequest(requestId)!.attempts, message: 'Route temporarily paused; retry later with the same key.' } }
    }
    let lastStatus = 0
    for (let index = 0; index < this.config.maxAttempts; index++) {
      const number = this.store.getRequest(requestId)!.attempts + 1
      const timestamp = String(Date.now())
      try {
        const response = await fetch(route.url, {
          method: 'POST', body: raw, redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            'Content-Type': 'application/json', 'Idempotency-Key': key,
            'X-BridgeGate-Request': requestId, 'X-BridgeGate-Timestamp': timestamp,
            'X-BridgeGate-Signature': signRequest(route.secret, timestamp, key, raw)
          }
        })
        lastStatus = response.status
        await response.body?.cancel()
        this.store.attempt(requestId, number, lastStatus, `Upstream HTTP ${lastStatus}`)
        if (response.ok) {
          this.failures.delete(routeId)
          this.store.finish(requestId, 'completed', lastStatus)
          return { status: 200, body: { requestId, route: routeId, attempts: number, state: 'completed', upstreamStatus: lastStatus, message: 'Forwarded successfully.' } }
        }
        if (lastStatus !== 429 && lastStatus < 500) {
          this.store.finish(requestId, 'rejected', lastStatus)
          return { status: 502, body: { requestId, route: routeId, attempts: number, state: 'rejected', upstreamStatus: lastStatus, message: 'Upstream rejected the request; inspect the route.' } }
        }
      } catch {
        lastStatus = 0
        this.store.attempt(requestId, number, 0, 'Upstream timeout or network error')
      }
      if (index < this.config.maxAttempts - 1) await pause(this.config.retryDelayMs * 2 ** index)
    }
    const latest = this.failures.get(routeId)
    const nextFailures = (latest?.openUntil && latest.openUntil < Date.now() ? 0 : latest?.count || 0) + 1
    const openUntil = nextFailures >= this.config.circuitThreshold ? Date.now() + this.config.circuitCooldownMs : 0
    this.failures.set(routeId, { count: nextFailures, openUntil })
    if (openUntil) this.store.audit('circuit_opened', 'Failure threshold reached', { clientId, routeId, requestId, status: 503 })
    this.store.finish(requestId, 'failed', lastStatus || null)
    return { status: 503, body: { requestId, route: routeId, attempts: this.store.getRequest(requestId)!.attempts,
      state: 'failed', upstreamStatus: lastStatus || undefined, message: 'Delivery attempts exhausted; retry later with the same key.' } }
  }

  close(): void { this.store.close() }
}
