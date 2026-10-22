# Webhook Payment Flow Test Plan - EU Pay

## 1. Test Scope

### 1.1 In Scope
This test plan defines the testing strategy, test scenarios, security verifications, and risk assessment for EU Pay's **Payment Webhook Processing Pipeline** (`POST /api/webhooks/payment-status` and downstream state management).
The scope includes:
- **Authentication & Cryptographic Integrity:** Verification of HMAC-SHA256 signatures using pre-shared webhook secrets.
- **Idempotency & Deduplication:** Prevention of duplicate side effects from repeated deliveries.
- **Payload Validation & Schema Conformance:** Verification of required fields (`payment_id`, `status`, `event_id`), data types, and status state machines.
- **Database State Synchronization:** Verification that underlying payment entities transition appropriately in persistence.
- **Security & Vulnerability Defenses:** Protection against replay attacks, timing attacks, SQL injection attempts, and stored XSS via webhook payloads.
- **Error Handling & Resilience:** Robust failure modes for unprocessable entities, unknown IDs, and malformed requests.

### 1.2 Out of Scope
- Frontend user interface rendering (Next.js merchant portal, mobile apps).
- Load, stress, and volumetric capacity testing beyond concurrency race condition validation.
- Internal bank clearing network mechanics and third-party bank core network protocols (AIS/PIS internal hops within Powens/Bridge).
- TLS certificate authority handshakes at CDN edge layers.

---

## 2. Test Environment

| Component | Specification | Description |
|---|---|---|
| **Target Application** | Node.js Express API | Hosted on `http://localhost:3000` (or ephemeral test port during CI) |
| **Test Framework** | Node.js Test Runner (`node:test`, `node:assert`) | Built-in test execution harness |
| **API Client Simulator** | Supertest (`^6.3.4`) & curl scripts | Emulating upstream payment service providers (Powens, Bridge, Stripe) |
| **Database** | In-Memory Relational Mock (`src/db/database.js`) | Reset per suite to ensure pristine test isolation |
| **Cryptographic Utility**| Node.js native `crypto` module | Generating SHA-256 HMAC signatures using `test-webhook-secret-key` |
| **Real-Time Gateway** | Socket.IO (`^4.7.2`) | Real-time merchant & table event emitter |

---

## 3. Test Scenarios

The following matrix covers the 12+ required test scenarios:

| ID | Scenario | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| **TC-WH-01** | Valid webhook with correct HMAC signature | Payment exists with status `pending` | Send `POST /api/webhooks/payment-status` with valid `x-webhook-signature`, `payment_id`, `status: "completed"`, `event_id`. | HTTP 200 OK, `{ success: true, new_status: "completed" }`, payment status updated in DB. | Critical |
| **TC-WH-02** | Webhook with invalid / tampered signature | Payment exists with status `pending` | Send `POST /api/webhooks/payment-status` with altered signature header or tampered body. | HTTP 401 Unauthorized, `{ error: "Invalid signature" }`, payment status remains unchanged. | Critical |
| **TC-WH-03** | Webhook with missing signature header | Payment exists with status `pending` | Send `POST /api/webhooks/payment-status` omitting `x-webhook-signature`. | HTTP 401 Unauthorized, rejection before business logic. | Critical |
| **TC-WH-04** | Duplicate webhook delivery (Idempotency) | Webhook previously processed successfully | Re-send identical payload with duplicate `event_id` and valid signature. | HTTP 200 OK, `{ message: "Already processed" }`, no secondary side-effects or state overwrite. | High |
| **TC-WH-05** | Webhook for non-existent payment | Target `payment_id: "99999"` does not exist in DB | Send validly signed webhook referencing non-existent payment ID. | HTTP 404 Not Found, `{ error: "Payment not found" }`. | High |
| **TC-WH-06** | Out-of-order webhook delivery (Webhook before payment created) | Payment record not yet committed due to network lag | Send webhook for uncommitted `payment_id`. | Handled gracefully: HTTP 404 returned (or HTTP 422/retry queue if upstream retry mechanism enabled). | Medium |
| **TC-WH-07** | State transition sequence (Multiple status updates) | Payment exists in `pending` | 1. Send webhook with `status: "processing"`.<br>2. Send second webhook with `status: "completed"`. | Each valid transition updates status sequentially: `pending` → `processing` → `completed`. | High |
| **TC-WH-08** | Missing required fields | Payment exists in `pending` | Send webhook omitting `payment_id` or `status` with valid signature. | HTTP 400 Bad Request, `{ error: "payment_id and status required" }`. | Medium |
| **TC-WH-09** | Malformed JSON body | Endpoint listening | Send raw unparseable payload (e.g. `{"payment_id": 1,`) with `Content-Type: application/json`. | HTTP 400 Bad Request / 500 parse failure caught by Express JSON parser. | Medium |
| **TC-WH-10** | Concurrent webhooks (Race condition) | Payment exists in `pending` | Fire 10 simultaneous HTTP requests with identical `event_id` and payload using `Promise.all()`. | Exactly 1 request executes full update; 9 requests return `{ message: "Already processed" }`. No data corruption. | High |
| **TC-WH-11** | SQL Injection attempt in `payment_id` | DB initialized | Send payload with `payment_id: "1' OR '1'='1"`. | Input treated strictly as literal string lookup; no unintended records modified; returns HTTP 404. | High |
| **TC-WH-12** | Signature timing attack resilience | Endpoint listening | Send signatures with varying matching prefixes against expected digest. | Constant-time comparison (`crypto.timingSafeEqual`) ensures uniform execution time, avoiding timing leakage. | Medium |
| **TC-WH-13** | Webhook replay attack (stale timestamp) | Payment exists | Send signed webhook with timestamp headers older than 5 minutes (tolerance window). | System detects expired event timestamp and rejects stale delivery. | High |
| **TC-WH-14** | Unsupported status value injection | Payment exists | Send payload with `status: "fraudulent_bypass"`. | If status validation enforced, rejected with 400 Bad Request. | Medium |

---

## 4. Security Tests

### 4.1 HMAC-SHA256 Signature Verification
- **Test:** Compute valid signature using `crypto.createHmac('sha256', secret)`. Modify 1 byte in payload body after signing.
- **Assertion:** Server must reject tampered payload with HTTP 401 Unauthorized.
- **Protection:** Guarantees authenticity and cryptographic non-repudiation.

### 4.2 Timing Attack Prevention
- **Test:** Use `crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))` rather than variable-time standard string comparison (`===`), preventing statistical side-channel analysis of partial digest matches.

### 4.3 Replay Attack Prevention
- **Test:** Deliver events with identical payload but altered timestamps or replay old `event_id`s outside acceptable processing windows.
- **Assertion:** Duplicate `event_id`s rejected via idempotency cache; events older than 300 seconds rejected if timestamp headers are enabled.

### 4.4 Injection Attack Vector Testing
- **SQL Injection:** Inject payloads containing `' OR 1=1 --`, `UNION SELECT`, and nested quotes into `payment_id` and `status`.
- **Stored XSS:** Inject `<script>alert('xss')</script>` or SVG image triggers into `status` or metadata fields. Verify strings are sanitized upon retrieval and never evaluated as raw HTML in merchant dashboards.

---

## 5. Edge Cases

| Case | Input Values | Verification Criterion |
|---|---|---|
| **Very Large `payment_id`** | `payment_id: "9".repeat(256)` | No server crash or buffer overflow; returns HTTP 404 cleanly. |
| **Unicode & Special Characters in Status** | `status: "completed ✅ 支付成功"` | Handled cleanly without encoding exceptions or character mangling. |
| **Empty or Null `event_id`** | `event_id: ""` or `null` | Rejected with 400 Bad Request or processed with fallback idempotency key. |
| **Extreme Payload Size** | 10 MB payload attempt | Terminated by `body-parser` size limits with HTTP 413 Payload Too Large. |
| **Future Timestamps** | `created_at` set 10 years in the future | Ignored or flagged for audit review. |

---

## 6. Integration Tests

### 6.1 Webhook → Database Status Persistence
- **Step 1:** Create new payment with initial status `'pending'`.
- **Step 2:** Transmit signed webhook with `status: 'completed'`.
- **Step 3:** Query `GET /api/payments/:id` with merchant JWT.
- **Validation:** Payment record reflects `status: 'completed'` and `webhook_received_at` is populated with a valid ISO timestamp.

### 6.2 Webhook → Real-Time Socket.IO Notification
- **Step 1:** Socket client joins merchant room: `socket.emit('join_merchant', '1')`.
- **Step 2:** POST webhook for payment belonging to Merchant 1.
- **Validation:** Socket client receives real-time update event `payment_updated` with payload `{ payment_id, status }`.

### 6.3 Failed Webhook & Retries
- **Step 1:** Simulate upstream failure (e.g., database timeout or temporary 503).
- **Step 2:** Upstream provider retries delivery at interval (10s, 30s, 60s).
- **Validation:** System recovers and acknowledges retried request with HTTP 200 upon service recovery without double credit.

---

## 7. Risk Assessment & Production Mitigation

| Risk | Production Consequence | Detection Mechanism | Mitigation Strategy |
|---|---|---|---|
| **Forged Webhook Injection** | Unpaid orders marked as completed; direct inventory and financial theft. | Ingress signature failure alarms, unusual spikes in completed transactions. | Enforce HMAC-SHA256 signature verification on all webhook ingress routes; rotate secret keys periodically via AWS Secrets Manager. |
| **Duplicate Delivery Race Conditions** | Duplicate merchant payouts, duplicate order dispatch, corrupted balances. | Distributed audit logs flagging multiple invocations for single `event_id`. | Implement atomic Redis distributed lock (`SETNX`) with TTL on `event_id` before database mutation. |
| **Silent Webhook Dropouts / Network Partitions** | Payment settled at bank but merchant app remains stuck in `'pending'`. | Scheduled reconciliation worker detecting pending payments older than 30 minutes. | Implement background cron reconciliation polling bank APIs directly for stale pending payments. |
| **Timing Attack on Signature Validation** | Attacker infers secret key character-by-character over high request volumes. | High frequency of 401s from single IP subnet. | Use `crypto.timingSafeEqual()` for constant-time byte comparison; enforce Cloudflare rate-limiting. |
| **Exhaustion of Memory Cache** | Server memory exhaustion caused by unbounded in-memory array growth. | Node.js process memory metrics (`process.memoryUsage()`). | Transition `processed_webhooks` from in-memory array to Redis cache with automatic 7-day TTL expiration. |
