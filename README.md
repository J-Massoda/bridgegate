# BridgeGate

BridgeGate is a Node.js and TypeScript integration gateway prototype. It accepts an event from an authenticated client, sends it only to a configured destination, retries temporary failures, and records what happened in SQLite. It explores a common problem for growing companies: one system says it sent an update, but the receiving system was briefly unavailable, leaving a team unsure whether the handoff completed.

**Everyday example:** a store says order 1042 changed. BridgeGate sends the update to its configured operations service. The service responds with a temporary `503`, then accepts a signed retry. If the store repeats the same request with the same idempotency key and body, BridgeGate returns its stored result without sending it again. The receiver still needs to deduplicate that key: a gateway retry can otherwise cause the receiver to act twice.

This is an independent portfolio prototype using fictional data, not a payment system or a production integration service. No paid API is required.

## See it work

The standalone [`docs/index.html`](docs/index.html) is a **fictional visual walkthrough** suitable for GitHub Pages. It simulates the failure, retry, replay and conflict in the visitor's browser. It does not connect to the working gateway.

The local demonstration runs a real gateway and a deliberately unreliable local receiver. Install Node.js **24.2 or newer**, then from this folder:

```sh
npm ci
npm run demo:check
```

Expected result: the receiver returns `503` on the first attempt and `200` on the second; repeating the same request returns the stored result. The script then prints the audit count and removes its temporary database. The project uses Node's built-in SQLite module, which Node documents as no longer experimental in the 24.2 line. See [Node's SQLite documentation](https://nodejs.org/api/sqlite.html).

To keep the gateway running and open the walkthrough locally:

**PowerShell**

```powershell
$env:GATEWAY_MODE = "demo"
npm run demo
```

**macOS / Linux**

```sh
GATEWAY_MODE=demo npm run demo
```

Open `http://127.0.0.1:8787/`. The page is a visual simulation. For a **real** request to the running local gateway, use another PowerShell terminal:

```powershell
$headers = @{
  Authorization = "Bearer local-demo-key-change-me"
  "Idempotency-Key" = "order-1042-demo"
}
$body = '{"type":"order.updated","data":{"reference":"FICTIONAL-1042"}}'
Invoke-RestMethod -Uri "http://127.0.0.1:8787/v1/forward/orders" -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

Run the same command again to see `replayed: true`. The result contains a `requestId`. To view the redacted audit trail:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8787/v1/audit" -Headers @{Authorization="Bearer local-admin-key-change-me"}
```

The demo keys are public examples and **only for loopback testing**. Demo mode refuses to bind to a non-loopback address. Use a new idempotency key to test a new sample event.

## What the working gateway includes

| Mechanism | What it does |
| --- | --- |
| Client authentication | Requires a configured bearer key. Admin audit access uses a separate key. |
| Fixed routes | A client chooses a configured route ID, never an arbitrary URL. Non-loopback routes require HTTPS; redirects are not followed. |
| Input limit | Accepts JSON with `type` and a `data` object, up to 64 KB. |
| Rate limit | Limits requests per client in one running process and returns `429` plus `Retry-After`. |
| Signed delivery | Sends `X-BridgeGate-Timestamp`, `Idempotency-Key` and an HMAC-SHA256 signature over `timestamp.key.raw-body`. |
| Idempotency | Saves a body hash, delivery state and attempts in SQLite. Same key and body replays completed results; a changed body returns `409`. |
| Failure handling | Retries timeouts, `429` and `5xx` responses with bounded backoff. A route pauses briefly after repeated exhausted requests. |
| Redacted audit | Stores audit event kind, IDs, status and timing, without bearer keys, signing secrets or request bodies. |

The gateway makes **at-least-once attempts**. The receiver must verify the signature and timestamp, and deduplicate by idempotency key before performing a side effect. The included receiver demonstrates signature checking and fails once on purpose.

## API

| Method and path | Access | Meaning |
| --- | --- | --- |
| `POST /v1/forward/orders` | Client bearer key | Forward an event with an `Idempotency-Key` header. |
| `GET /v1/requests/{requestId}` | Admin bearer key | Read the redacted delivery state and attempt count. |
| `GET /v1/audit?limit=50` | Admin bearer key | Read recent redacted events (up to 100). |
| `GET /health` | Public | Simple process health response. |

The demo also configures an `updates` route. A non-demo start configures `orders` from `GATEWAY_ORDERS_URL`.

## Configuration for a private test environment

With `GATEWAY_MODE` unset, the service requires:

```text
GATEWAY_CLIENTS={"example-client":"a-long-private-client-key"}
GATEWAY_ADMIN_KEY=a-different-long-private-admin-key
GATEWAY_SIGNING_SECRET=a-long-private-signing-secret
GATEWAY_ORDERS_URL=https://your-owned-receiver.example/events
GATEWAY_DB_PATH=./data/bridgegate.sqlite3
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=8787
```

These are **example variable names and placeholder values**, not credentials. Store real keys outside the repository. Use `npm run dev` for TypeScript development or `npm run build` followed by `npm start` for compiled JavaScript. Run from the repository root so the demo page resolves correctly.

This version is a **single-process** gateway. SQLite persists delivery state and audit records, while the rate limiter, in-flight coordination and circuit breaker are in memory. Multiple instances, public exposure, secret rotation, trusted TLS termination, distributed rate limiting, durable background queues, audit retention and receiver-specific recovery need separate engineering. Do not route confidential or payment data through this local prototype.

## Source and tests

| Path | Role |
| --- | --- |
| `src/http.ts` | HTTP parsing, authentication, fixed paths and input limits. |
| `src/gateway.ts` | Retry, idempotency replay, rate limit, single-flight handling and circuit breaker. |
| `src/store.ts` | Persistent SQLite request and audit state. |
| `src/security.ts` | Constant-time key comparison and HMAC signing. |
| `src/demo-sink.ts` | Local receiver that verifies signatures and fails once. |
| `scripts/demo-check.ts` | One-command real local demonstration. |
| `tests/gateway.test.ts` | Local HTTP integration tests. |
| `docs/index.html` | Static GitHub Pages walkthrough. |

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run demo:check
```

The tests exercise signed retries, replay after a restart, changed-body conflicts, unauthorized and malformed traffic, rate limits, concurrent duplicate requests, redacted audit output and circuit breaking. They use disposable loopback servers and temporary databases.

## License

MIT; see [`LICENSE`](LICENSE).
