export type Route = { id: string; url: string; secret: string }
export type GatewayConfig = {
  clients: Record<string, string>
  adminKey: string
  routes: Record<string, Route>
  dbPath: string
  rateLimit: number
  rateWindowMs: number
  maxAttempts: number
  timeoutMs: number
  retryDelayMs: number
  circuitThreshold: number
  circuitCooldownMs: number
  demo?: boolean
}
export type Result = { status: number; body: { requestId: string; state: string; route: string; attempts: number; upstreamStatus?: number; message: string; replayed?: boolean } }
