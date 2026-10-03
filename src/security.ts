import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export function equalSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

export function clientFromBearer(header: string | undefined, clients: Record<string, string>): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7)
  // Compare against each configured client without short-circuiting the scan.
  let match: string | null = null
  for (const [id, secret] of Object.entries(clients)) if (equalSecret(token, secret)) match = id
  return match
}

export function signRequest(secret: string, timestamp: string, idempotencyKey: string, raw: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${idempotencyKey}.${raw}`).digest('hex')
}

export function verifySignature(secret: string, timestamp: string, key: string, raw: string, received: string): boolean {
  return equalSecret(signRequest(secret, timestamp, key, raw), received)
}

export function bodyHash(raw: string): string { return createHash('sha256').update(raw).digest('hex') }
