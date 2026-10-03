import { createServer as nodeCreateServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Gateway } from './gateway.js'
import { clientFromBearer, equalSecret } from './security.js'
import type { GatewayConfig } from './types.js'

const MAX_BODY = 64 * 1024

export function validateConfig(config: GatewayConfig): void {
  if (config.adminKey.length < 16 || Object.keys(config.clients).length === 0) throw new Error('Configure client and admin keys of at least 16 characters.')
  for (const [id, secret] of Object.entries(config.clients)) if (!/^[a-z0-9_-]{2,40}$/.test(id) || secret.length < 16) throw new Error('Invalid client ID or short key.')
  if (new Set(Object.values(config.clients)).size !== Object.keys(config.clients).length) throw new Error('Client keys must be unique.')
  if (Object.values(config.clients).includes(config.adminKey)) throw new Error('The admin key must differ from client keys.')
  if (!Number.isInteger(config.rateLimit) || config.rateLimit < 1 || !Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 5 || config.timeoutMs < 100 || config.rateWindowMs < 1000 || config.circuitThreshold < 1 || config.circuitCooldownMs < 1000 || config.retryDelayMs < 0) throw new Error('Invalid gateway limits.')
  for (const [id, route] of Object.entries(config.routes)) {
    const url = new URL(route.url)
    if (id !== route.id || !/^[a-z0-9_-]{1,40}$/.test(id) || route.secret.length < 16 || url.username || url.password || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
      throw new Error('Route destinations must be fixed HTTPS URLs or loopback HTTP for local testing.')
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const length = Number(req.headers['content-length'])
  if (Number.isFinite(length) && length > MAX_BODY) throw new Error('too_large')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) { req.resume(); throw new Error('too_large') }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function validPayload(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return typeof record.type === 'string' && /^[a-z][a-z0-9._-]{1,79}$/.test(record.type) &&
      !!record.data && typeof record.data === 'object' && !Array.isArray(record.data)
  } catch { return false }
}

export function createGatewayServer(config: GatewayConfig): { server: Server; gateway: Gateway } {
  validateConfig(config)
  const gateway = new Gateway(config)
  const server = nodeCreateServer((req, res) => {
    void handle(req, res, gateway, config).catch(() => {
      gateway.store.audit('internal_error', 'Unexpected gateway error', { status: 500 })
      if (!res.headersSent) json(res, 500, { error: 'Internal gateway error.' })
      else res.end()
    })
  })
  return { server, gateway }
}

async function handle(req: IncomingMessage, res: ServerResponse, gateway: Gateway, config: GatewayConfig): Promise<void> {
  const path = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'GET' && path.pathname === '/health') return json(res, 200, { status: 'ok' })
  if (req.method === 'GET' && path.pathname === '/' && config.demo) {
    const file = resolve(process.cwd(), 'docs/index.html')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(readFileSync(file))
    return
  }
  const header = req.headers.authorization
  const admin = header?.startsWith('Bearer ') && equalSecret(header.slice(7), config.adminKey)
  if (req.method === 'GET' && path.pathname === '/v1/audit') {
    if (!admin) { gateway.store.audit('admin_denied', 'Invalid audit credential', { status: 401 }); return json(res, 401, { error: 'Admin credential required.' }) }
    return json(res, 200, { events: gateway.store.recentAudit(Number(path.searchParams.get('limit') || 50)) })
  }
  const requestMatch = path.pathname.match(/^\/v1\/requests\/([a-f0-9-]{36})$/)
  if (req.method === 'GET' && requestMatch) {
    if (!admin) return json(res, 401, { error: 'Admin credential required.' })
    const row = gateway.store.getRequest(requestMatch[1]!)
    if (!row) return json(res, 404, { error: 'Request not found.' })
    const { id, client_id, route_id, state, attempts, upstream_status, created_at, updated_at } = row
    return json(res, 200, { id, client_id, route_id, state, attempts, upstream_status, created_at, updated_at })
  }
  const forward = path.pathname.match(/^\/v1\/forward\/([a-z0-9_-]{1,40})$/)
  if (req.method !== 'POST' || !forward) return json(res, 404, { error: 'Route not found.' })
  const clientId = clientFromBearer(header, config.clients)
  if (!clientId) { gateway.store.audit('auth_denied', 'Invalid client credential', { status: 401 }); return json(res, 401, { error: 'Client credential required.' }) }
  const routeId = forward[1]!
  if (!config.routes[routeId]) return json(res, 404, { error: 'Unknown fixed route.' })
  const limit = gateway.rate(clientId)
  if (!limit.allowed) return json(res, 429, { error: 'Rate limit reached.' }, { 'Retry-After': String(limit.retryAfter) })
  const key = req.headers['idempotency-key']
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) return json(res, 400, { error: 'Provide an Idempotency-Key of 8–100 letters, numbers, underscores or hyphens.' })
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Content-Type must be application/json.' })
  let raw: string
  try { raw = await readBody(req) } catch (error) {
    return json(res, error instanceof Error && error.message === 'too_large' ? 413 : 400, { error: 'Request body could not be read or exceeds 64 KB.' })
  }
  if (!validPayload(raw)) return json(res, 400, { error: 'Expected JSON with a type and a data object.' })
  const result = await gateway.submit(clientId, routeId, key, raw)
  json(res, result.status, result.body)
}
