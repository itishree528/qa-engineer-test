# Bug Reports - EU Pay QA Engineer Technical Assessment

This document contains comprehensive bug reports for all 7 intentional bugs identified in the EU Pay payment processing API.

---

## Bug A: Payment Amount Returned as String Instead of Number

**Location:** `src/routes/payment.routes.js` (lines 16, 52)  
**Severity:** Medium  
**Component:** Payment API  

### How to Reproduce:
1. Start the server: `npm start`
2. Obtain a JWT token by logging in:
   ```bash
   curl -s -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"merchant@test.com","password":"Test123!"}'
   ```
3. Fetch the list of payments using the received JWT token:
   ```bash
   curl -s http://localhost:3000/api/payments \
     -H "Authorization: Bearer <TOKEN>"
   ```
4. Fetch a single payment:
   ```bash
   curl -s http://localhost:3000/api/payments/1 \
     -H "Authorization: Bearer <TOKEN>"
   ```
5. Inspect the `amount` field in the JSON response payload.

### Expected Behavior:
The `amount` property in each payment object should be a numeric float/integer type (e.g., `25.5` or `100`), adhering to standard REST API specifications for financial calculations and schemas.

### Actual Behavior:
The `amount` property is returned as a string literal (e.g., `"25.5"`, `"100"`).

### Impact:
Client-side web, mobile (Flutter/React), and POS systems performing calculations (such as totals, tax computations, fee deductions, or charts) will experience string concatenation bugs (e.g., `"25.5" + 5` results in `"25.55"` instead of `30.5`) or `NaN` errors, causing checkout inconsistencies, distorted financial reports, and potential reconciliation errors.

### Root Cause:
In `src/routes/payment.routes.js`, lines 16 and 52 explicitly call `.toString()` on the numeric amount:
```javascript
amount: p.amount.toString(), // Line 16
amount: payment.amount.toString(), // Line 52
```

### Suggested Fix:
Return the amount as a float/number without string conversion:
```javascript
amount: parseFloat(p.amount),
```
and for single payment:
```javascript
amount: parseFloat(payment.amount),
```

---

## Bug B: Missing Maximum Amount Validation on Payment Creation

**Location:** `src/routes/payment.routes.js` (lines 75-78)  
**Severity:** High  
**Component:** Payment API  

### How to Reproduce:
1. Start the server: `npm start`
2. Authenticate as a merchant to get a JWT token.
3. Submit a new payment creation request with an exorbitant amount (€999,999,999):
   ```bash
   curl -s -X POST http://localhost:3000/api/payments \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"amount": 999999999, "currency": "EUR", "customer_email": "whale@test.com"}'
   ```
4. Observe the response status code and body.

### Expected Behavior:
The API should enforce risk thresholds and regulatory limits (e.g., PSD2 / AML maximum transaction limit of €50,000 per payment). Requests exceeding this limit should be rejected with HTTP 400 Bad Request:
```json
{
  "error": "Amount exceeds maximum limit of €50,000"
}
```

### Actual Behavior:
The server returns HTTP 201 Created and persists the payment of €999,999,999 without any upper bound validation.

### Impact:
Permitting unbounded payment amounts exposes merchants and the payment platform to severe Anti-Money Laundering (AML) non-compliance penalties, fraudulent card testing, catastrophic chargeback liabilities, and arithmetic overflow errors in downstream ledger systems.

### Root Cause:
`src/routes/payment.routes.js` validates `amount <= 0` and non-numeric inputs, but lacks an upper bound guard clause.

### Suggested Fix:
Add an upper limit check immediately following the basic amount validation:
```javascript
const MAX_PAYMENT_AMOUNT = 50000;
if (amount > MAX_PAYMENT_AMOUNT) {
  return res.status(400).json({ error: `Amount exceeds maximum limit of €${MAX_PAYMENT_AMOUNT.toLocaleString()}` });
}
```

---

## Bug C: Email Validation Regex Is Too Permissive (Missing TLD Check)

**Location:** `src/routes/auth.routes.js` (lines 10-14)  
**Severity:** Medium  
**Component:** Auth API  

### How to Reproduce:
1. Start the server: `npm start`
2. Send a registration request with an email lacking a top-level domain (TLD), such as `merchant@localhost` or `user@domain`:
   ```bash
   curl -s -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"user@domain","password":"SecurePassword123!","business_name":"Acme Corp"}'
   ```
3. Observe the response status code.

### Expected Behavior:
The endpoint should reject invalid email formats missing a valid TLD with HTTP 400 Bad Request:
```json
{
  "error": "Invalid email format"
}
```

### Actual Behavior:
The server returns HTTP 201 Created and successfully registers the account with an unroutable email.

### Impact:
Users can register with invalid or uncontactable email addresses. Transaction receipts, password reset tokens, MFA verifications, and dispute notifications cannot be delivered, creating operational overhead, user lockout, and orphaned merchant accounts.

### Root Cause:
The regular expression used in `validateEmail()` only checks for an `@` symbol between non-whitespace sequences without validating domain structure or TLD:
```javascript
const emailRegex = /^[^\s@]+@[^\s@]+$/;
```

### Suggested Fix:
Update the validation regex to enforce a dot and valid top-level domain:
```javascript
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

---

## Bug D: Missing Webhook Signature Verification

**Location:** `src/routes/webhook.routes.js` (lines 21-33)  
**Severity:** Critical  
**Component:** Webhook API  

### How to Reproduce:
1. Start the server: `npm start`
2. Send a payment status webhook with an arbitrary, fake signature or omitting the signature header:
   ```bash
   curl -s -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -H "x-webhook-signature: malicious-fake-signature" \
     -d '{"payment_id":"2","status":"completed","event_id":"evt_spoof_001"}'
   ```
3. Check payment status:
   ```bash
   curl -s http://localhost:3000/api/payments/2 \
     -H "Authorization: Bearer <TOKEN>"
   ```

### Expected Behavior:
The server must verify the HMAC-SHA256 signature provided in the `x-webhook-signature` header against the HMAC digest computed using `WEBHOOK_SECRET` over the raw payload. If the signature is missing or incorrect, it must reject the request immediately with HTTP 401 Unauthorized:
```json
{
  "error": "Invalid signature"
}
```

### Actual Behavior:
The endpoint completely ignores the signature, accepts the forged webhook, returns HTTP 200 OK, and updates the payment status in the database to `"completed"`.

### Impact:
Critical security flaw. Any malicious actor on the internet can spoof payment callbacks from providers like Powens or Stripe, marking pending or unpaid transactions as "completed" without real funds being transferred, leading to direct financial theft and inventory loss.

### Root Cause:
The HMAC-SHA256 signature verification logic was left commented out in `src/routes/webhook.routes.js` (lines 25-32).

### Suggested Fix:
Uncomment and enforce signature validation before processing the webhook payload:
```javascript
const expectedSignature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(JSON.stringify(req.body))
  .digest('hex');

if (!signature || signature !== expectedSignature) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

---

## Bug E: Missing Webhook Idempotency Check

**Location:** `src/routes/webhook.routes.js` (lines 38-45, 56-57)  
**Severity:** High  
**Component:** Webhook API  

### How to Reproduce:
1. Start the server: `npm start`
2. Submit a valid webhook event twice with the identical `event_id`:
   ```bash
   # First request
   curl -s -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -H "x-webhook-signature: <VALID_HMAC>" \
     -d '{"payment_id":"1","status":"completed","event_id":"evt_unique_101"}'

   # Duplicate request
   curl -s -X POST http://localhost:3000/api/webhooks/payment-status \
     -H "Content-Type: application/json" \
     -H "x-webhook-signature: <VALID_HMAC>" \
     -d '{"payment_id":"1","status":"completed","event_id":"evt_unique_101"}'
   ```
3. Observe the response of the second request.

### Expected Behavior:
Payment webhooks follow an at-least-once delivery model. When a duplicate `event_id` arrives, the system must recognize it as already processed, skip duplicate state transitions and event emissions, and return HTTP 200 OK with:
```json
{
  "message": "Already processed"
}
```

### Actual Behavior:
Both requests process fully, overwrite `payment.webhook_received_at`, and re-execute payment update logic.

### Impact:
Duplicate deliveries cause race conditions, multiple fulfillment triggers, duplicate customer notifications, and potential double refund/payout actions in downstream workflows.

### Root Cause:
The idempotency lookup in `db.processed_webhooks` and recording of processed `event_id`s were commented out (lines 42-44, 56).

### Suggested Fix:
Check if `event_id` exists in `db.processed_webhooks`, return early if already processed, and append newly processed IDs:
```javascript
if (event_id && db.processed_webhooks.includes(event_id)) {
  return res.status(200).json({ message: 'Already processed' });
}

// After updating payment:
if (event_id) {
  db.processed_webhooks.push(event_id);
}
```

---

## Bug F: Missing Duplicate Table Order Prevention

**Location:** `src/routes/table-order.routes.js` (lines 44-56)  
**Severity:** Medium  
**Component:** Table Orders API  

### How to Reproduce:
1. Start the server: `npm start`
2. Create an initial table order for Table 5 under Merchant "1":
   ```bash
   curl -s -X POST http://localhost:3000/api/table-orders \
     -H "Content-Type: application/json" \
     -d '{
       "merchant_id": "1",
       "table_number": 5,
       "items": [{"name": "Pasta", "price": 12.50, "quantity": 1}],
       "customer_name": "Alice"
     }'
   ```
3. Without completing or cancelling the first order, send another order creation request for the same merchant and Table 5:
   ```bash
   curl -s -X POST http://localhost:3000/api/table-orders \
     -H "Content-Type: application/json" \
     -d '{
       "merchant_id": "1",
       "table_number": 5,
       "items": [{"name": "Pizza", "price": 15.00, "quantity": 1}],
       "customer_name": "Bob"
     }'
   ```
4. Observe the response of the second order.

### Expected Behavior:
A table with an existing active `pending` order should not accept a second concurrent pending order until the previous order has been processed or updated. The second request should be rejected with HTTP 409 Conflict:
```json
{
  "error": "Table already has a pending order"
}
```

### Actual Behavior:
The API returns HTTP 201 Created and creates two separate active pending orders for Table 5.

### Impact:
In restaurant dining operations, accidental duplicate order submissions (e.g., from network retries, double taps on QR code order apps, or multiple patrons at the same table) cause the kitchen to prepare dishes twice, generating food waste, billing discrepancies, and merchant revenue loss.

### Root Cause:
The check for existing pending orders for the same `merchant_id` and `table_number` was commented out (lines 48-55).

### Suggested Fix:
Check if a pending order already exists before creating a new table order:
```javascript
const existingOrder = (db.table_orders || []).find(
  o => o.merchant_id === merchant_id && 
       o.table_number === table_number && 
       o.status === 'pending'
);
if (existingOrder) {
  return res.status(409).json({ error: 'Table already has a pending order' });
}
```

---

## Bug G: Missing Duplicate E-Invoice Submission Check

**Location:** `src/routes/einvoice.routes.js` (lines 50-59)  
**Severity:** Medium  
**Component:** E-Invoicing API  

### How to Reproduce:
1. Start the server: `npm start`
2. Authenticate as a merchant to receive a JWT token.
3. Submit an invoice for e-invoicing:
   ```bash
   curl -s -X POST http://localhost:3000/api/einvoice/submit \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"invoice_id": "INV_2026_001", "customer_siret": "12345678901234"}'
   ```
4. Immediately submit the exact same invoice ID again:
   ```bash
   curl -s -X POST http://localhost:3000/api/einvoice/submit \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"invoice_id": "INV_2026_001", "customer_siret": "12345678901234"}'
   ```
5. Check the response status and submission ID.

### Expected Behavior:
In European mandatory e-invoicing frameworks (such as France's PDP / Chorus Pro), an invoice already submitted or accepted cannot be re-submitted. The API should reject repeated submissions with HTTP 409 Conflict:
```json
{
  "error": "Invoice already submitted to tax authority"
}
```

### Actual Behavior:
The API returns HTTP 200 OK on both calls, generating multiple new submission IDs (`SUB-...`) and re-submitting the same invoice.

### Impact:
Duplicate submissions to tax authorities trigger compliance errors, audit discrepancies, duplicate VAT liability calculations, and potential fines for merchants under electronic invoicing regulations.

### Root Cause:
The validation checking `invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted'` was commented out (lines 54-58).

### Suggested Fix:
Verify whether the invoice has already been submitted or accepted before generating a new tax submission:
```javascript
if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
  return res.status(409).json({ 
    error: 'Invoice already submitted to tax authority' 
  });
}
```
