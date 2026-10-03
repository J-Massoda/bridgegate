import { createServer, type Server } from 'node:http'
import { verifySignature } from './security.js'

export function createDemoSink(secret: string): { server: Server; counts: Map<string, number> } {
  const counts = new Map<string, number>()
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/receiver') { res.writeHead(404); res.end(); return }
    let raw = ''
    for await (const part of req) {
      raw += part.toString()
      if (raw.length > 70_000) { res.writeHead(413); res.end(); return }
    }
    const key = String(req.headers['idempotency-key'] || '')
    const timestamp = String(req.headers['x-bridgegate-timestamp'] || '')
    const signature = String(req.headers['x-bridgegate-signature'] || '')
    if (Math.abs(Date.now() - Number(timestamp)) > 300_000 || !verifySignature(secret, timestamp, key, raw, signature)) {
      res.writeHead(401); res.end(); return
    }
    const attempts = (counts.get(key) || 0) + 1
    counts.set(key, attempts)
    res.writeHead(attempts === 1 ? 503 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ received: attempts, example: true }))
  })
  return { server, counts }
}
