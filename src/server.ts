import { createDemoSink } from './demo-sink.js'
import { createGatewayServer } from './http.js'
import type { GatewayConfig, Route } from './types.js'
import type { Server } from 'node:http'

const demo = process.env.GATEWAY_MODE === 'demo'
const host = process.env.GATEWAY_HOST || '127.0.0.1'
const port = Number(process.env.GATEWAY_PORT || '8787')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GATEWAY_PORT must be a valid port.')
if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Demo mode only binds to loopback.')

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })
}

async function main() {
  const demoClient = 'local-demo-key-change-me'
  const demoAdmin = 'local-admin-key-change-me'
  const signing = process.env.GATEWAY_SIGNING_SECRET || (demo ? 'local-demo-signing-change-me' : '')
  const sink = demo ? createDemoSink(signing) : null
  let sinkPort = 0
  if (sink) sinkPort = await listen(sink.server, 0, '127.0.0.1')
  try {
    let clients: Record<string, string>
    try { clients = demo ? { 'demo-client': demoClient } : JSON.parse(process.env.GATEWAY_CLIENTS || '{}') as Record<string, string> }
    catch { throw new Error('GATEWAY_CLIENTS must be a JSON object of client IDs and API keys.') }
    const routes: Record<string, Route> = demo ? {
      orders: { id: 'orders', url: `http://127.0.0.1:${sinkPort}/receiver`, secret: signing },
      updates: { id: 'updates', url: `http://127.0.0.1:${sinkPort}/receiver`, secret: signing }
    } : {
      orders: { id: 'orders', url: process.env.GATEWAY_ORDERS_URL || '', secret: signing }
    }
    const config: GatewayConfig = {
      clients, adminKey: demo ? demoAdmin : process.env.GATEWAY_ADMIN_KEY || '', routes,
      dbPath: process.env.GATEWAY_DB_PATH || './data/bridgegate.sqlite3',
      rateLimit: 30, rateWindowMs: 60_000, maxAttempts: 3, timeoutMs: 3_000,
      retryDelayMs: 200, circuitThreshold: 3, circuitCooldownMs: 30_000, demo
    }
    const { server, gateway } = createGatewayServer(config)
    await listen(server, port, host)
    console.log(`BridgeGate ${demo ? 'local demo' : 'gateway'} listening at http://${host}:${port}`)
    if (demo) console.log(`Open http://${host}:${port}/ for the guided walkthrough. Run npm run demo:check for the real retry path.`)
    let closing = false
    const shutdown = () => {
      if (closing) return
      closing = true
      server.close(() => { gateway.close(); sink?.server.close(); process.exit(0) })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    sink?.server.close()
    throw error
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1 })
