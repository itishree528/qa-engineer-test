# Bug Fixes Documentation - EU Pay QA Engineer Assessment

This document details all code changes made to fix the 7 identified bugs in the EU Pay payment processing platform, following the required submission format.

---

## Fix 1: Payment Amount Data Type (Bug A)

**Bug:** Payment amount was converted to a string (`amount: p.amount.toString()`) in `GET /api/payments` and `GET /api/payments/:id`, instead of returning a number.

**Files Changed:**
- `src/routes/payment.routes.js` (lines 16, 52)

**Code Changes:**
```diff
--- a/src/routes/payment.routes.js
+++ b/src/routes/payment.routes.js
@@ -13,7 +13,7 @@ router.get('/', authenticate, (req, res) => {
     // BUG A FIX: Keep amount as numeric float/number instead of string
     const formattedPayments = payments.map(p => ({
       id: p.id,
-      amount: p.amount.toString(), // ← BUG: Should be number, not string
+      amount: parseFloat(p.amount),
       currency: p.currency,
       status: p.status,
       customer_email: p.customer_email,
@@ -49,7 +49,7 @@ router.get('/:id', authenticate, (req, res) => {
     res.json({
       success: true,
       data: {
         id: payment.id,
-        amount: payment.amount.toString(), // Same bug as above
+        amount: parseFloat(payment.amount),
         currency: payment.currency,
         status: payment.status,
         customer_email: payment.customer_email,
```

**Why This Fix:**
Frontend applications (Flutter mobile clients, Next.js dashboard, checkout SDKs, POS terminals) perform arithmetic operations, fee calculations, and currency conversions on the client side. Returning amounts as string types produces `NaN` errors or incorrect string concatenation (e.g., `"25.5" + 5 = "25.55"` instead of `30.5`). Using `parseFloat()` preserves IEEE-754 decimal values while ensuring strict compliance with numeric JSON schemas.

**Testing:**
```bash
# Login and get token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"merchant@test.com","password":"Test123!"}' | jq -r .token)

# Query payments
curl -s http://localhost:3000/api/payments -H "Authorization: Bearer $TOKEN"
# Verification: data[0].amount is typeof "number" (25.5), NOT "25.5"
```

---

## Fix 2: Payment Maximum Amount Validation (Bug B)

**Bug:** `POST /api/payments` lacked an upper bound limit, permitting merchants or attackers to initiate payments exceeding risk policies (e.g. €999,999,999).

**Files Changed:**
- `src/routes/payment.routes.js` (lines 75-78)

**Code Changes:**
```diff
--- a/src/routes/payment.routes.js
+++ b/src/routes/payment.routes.js
@@ -72,6 +72,11 @@ router.post('/', authenticate, (req, res) => {
       return res.status(400).json({ error: 'Valid amount is required' });
     }
 
+    // BUG B FIX: Maximum amount check - limits transaction to max €50,000
+    if (amount > 50000) {
+      return res.status(400).json({ error: 'Amount exceeds maximum limit of €50,000' });
+    }
+
     if (!currency || !['EUR', 'USD', 'GBP'].includes(currency)) {
       return res.status(400).json({ error: 'Valid currency is required (EUR, USD, GBP)' });
     }
```

**Why This Fix:**
Payment institutions operating under European PSD2 and AML (Anti-Money Laundering) directives must enforce per-transaction thresholds to mitigate fraudulent money movement, credit card testing, and fat-finger human errors. Restricting single transactions to €50,000 aligns with standard payment gateway velocity controls and European Open Banking limits.

**Testing:**
```bash
# Attempt to create payment of €999,999
curl -s -X POST http://localhost:3000/api/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount": 999999, "currency": "EUR", "customer_email": "whale@test.com"}'

# Response: HTTP 400 Bad Request
# {"error": "Amount exceeds maximum limit of €50,000"}
```

---

## Fix 3: Registration Email Regex Validation (Bug C)

**Bug:** Email validation regex in `validateEmail()` allowed malformed emails without a top-level domain (e.g., `user@domain`).

**Files Changed:**
- `src/routes/auth.routes.js` (lines 10-14)

**Code Changes:**
```diff
--- a/src/routes/auth.routes.js
+++ b/src/routes/auth.routes.js
@@ -7,9 +7,9 @@ const router = express.Router();
 const JWT_SECRET = 'test-secret-key-do-not-use-in-production';
 
-// BUG C: Email validation is too permissive
+// BUG C FIX: Enforce valid email format requiring username, domain, and TLD
 function validateEmail(email) {
-  // BUG: This regex allows emails without TLD like "user@domain"
-  const emailRegex = /^[^\s@]+@[^\s@]+$/;
+  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
   return emailRegex.test(email);
 }
```

**Why This Fix:**
Without enforcing a domain separator (`.`) and TLD, users can register with internal hostnames or malformed strings. This prevents delivery of critical transactional communications (password resets, invoice delivery, payment receipts, KYC documents). The updated pattern `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` requires both an `@` symbol and a valid domain dot followed by non-whitespace TLD characters.

**Testing:**
```bash
# Register with invalid email (no TLD)
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@domain","password":"SecurePassword123!","business_name":"Acme Corp"}'

# Response: HTTP 400 Bad Request
# {"error": "Invalid email format"}

# Register with valid email
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@domain.com","password":"SecurePassword123!","business_name":"Acme Corp"}'

# Response: HTTP 201 Created
```

---

## Fix 4: Webhook HMAC-SHA256 Signature Verification (Bug D)

**Bug:** `POST /api/webhooks/payment-status` accepted requests without verifying the HMAC signature header `x-webhook-signature`, allowing arbitrary webhook spoofing.

**Files Changed:**
- `src/routes/webhook.routes.js` (lines 21-33)

**Code Changes:**
```diff
--- a/src/routes/webhook.routes.js
+++ b/src/routes/webhook.routes.js
@@ -21,15 +21,12 @@ router.post('/payment-status', (req, res) => {
-    // BUG D: No signature verification
-    // Real systems MUST verify webhook signatures to prevent spoofing
-    // Missing validation below:
-    
-    // const expectedSignature = crypto
-    //   .createHmac('sha256', WEBHOOK_SECRET)
-    //   .update(JSON.stringify(req.body))
-    //   .digest('hex');
-    // 
-    // if (signature !== expectedSignature) {
-    //   return res.status(401).json({ error: 'Invalid signature' });
-    // }
+    // BUG D FIX: HMAC-SHA256 signature verification to prevent webhook spoofing
+    const expectedSignature = crypto
+      .createHmac('sha256', WEBHOOK_SECRET)
+      .update(JSON.stringify(req.body))
+      .digest('hex');
+
+    if (signature !== expectedSignature) {
+      return res.status(401).json({ error: 'Invalid signature' });
+    }
```

**Why This Fix:**
Payment webhooks run over public internet endpoints. Without cryptographic signature verification using a pre-shared secret, any unauthenticated attacker could send falsified events marking unpaid invoices or payments as `"completed"`. Verifying the HMAC-SHA256 signature ensures both authenticity (sent by the trusted payment provider) and message integrity (payload not tampered in transit).

**Testing:**
```bash
# Send forged webhook
curl -s -X POST http://localhost:3000/api/webhooks/payment-status \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: invalid-signature" \
  -d '{"payment_id":"2","status":"completed","event_id":"evt_test"}'

# Response: HTTP 401 Unauthorized
# {"error": "Invalid signature"}
```

---

## Fix 5: Webhook Idempotency Check (Bug E)

**Bug:** `POST /api/webhooks/payment-status` processed duplicate webhook deliveries, repeatedly mutating records and timestamps.

**Files Changed:**
- `src/routes/webhook.routes.js` (lines 38-45, 56-57)

**Code Changes:**
```diff
--- a/src/routes/webhook.routes.js
+++ b/src/routes/webhook.routes.js
@@ -38,11 +38,8 @@ router.post('/payment-status', (req, res) => {
-    // BUG E: No idempotency check
-    // Webhooks can be delivered multiple times - must be idempotent
-    // Missing check below:
-    
-    // if (db.processed_webhooks.includes(event_id)) {
-    //   return res.status(200).json({ message: 'Already processed' });
-    // }
+    // BUG E FIX: Idempotency check to safely handle duplicate webhook deliveries
+    if (db.processed_webhooks.includes(event_id)) {
+      return res.status(200).json({ message: 'Already processed' });
+    }
@@ -53,4 +50,5 @@ router.post('/payment-status', (req, res) => {
     payment.status = status;
     payment.webhook_received_at = new Date();
 
-    // Mark webhook as processed (if idempotency was implemented)
-    // db.processed_webhooks.push(event_id);
+    // Mark webhook as processed
+    if (event_id) {
+      db.processed_webhooks.push(event_id);
+    }
```

**Why This Fix:**
Payment infrastructure (Powens, Stripe, Banking gateways) uses at-least-once message delivery. Retries frequently occur during transient network dropouts. Idempotency guarantees that processing the same event multiple times produces the exact same end state without duplicate side-effects (such as redundant order fulfillments, duplicate notifications, or multiple bank debits).

**Testing:**
```bash
# Valid signature computed for payload:
# First delivery -> HTTP 200 { "success": true, "message": "Webhook processed" }
# Second delivery with same event_id -> HTTP 200 { "message": "Already processed" }
```

---

## Fix 6: Duplicate Table Order Prevention (Bug F)

**Bug:** `POST /api/table-orders` did not verify if a table already had an open `pending` order, allowing duplicate concurrent orders for the same table.

**Files Changed:**
- `src/routes/table-order.routes.js` (lines 44-56)

**Code Changes:**
```diff
--- a/src/routes/table-order.routes.js
+++ b/src/routes/table-order.routes.js
@@ -44,14 +44,11 @@ router.post('/', (req, res) => {
-    // BUG F: No duplicate order prevention
-    // Should check if table already has a pending order
-    // Missing validation below:
-    
-    // const existingOrder = (db.table_orders || []).find(
-    //   o => o.merchant_id === merchant_id && 
-    //        o.table_number === table_number && 
-    //        o.status === 'pending'
-    // );
-    // if (existingOrder) {
-    //   return res.status(409).json({ error: 'Table already has a pending order' });
-    // }
+    // BUG F FIX: Prevent duplicate pending table orders
+    const existingOrder = (db.table_orders || []).find(
+      o => o.merchant_id === merchant_id && 
+           o.table_number === table_number && 
+           o.status === 'pending'
+    );
+    if (existingOrder) {
+      return res.status(409).json({ error: 'Table already has a pending order' });
+    }
```

**Why This Fix:**
In dining establishments, tables place orders via QR code apps. If two diners submit simultaneous orders, or a diner double-clicks the checkout button, allowing two concurrent pending orders results in redundant kitchen orders, food wastage, and billing disputes. Checking for an active pending order returns HTTP 409 Conflict, instructing the user to wait or add items to their active bill.

**Testing:**
```bash
# Submit order for Table 1 -> HTTP 201 Created
# Submit second order for Table 1 while pending -> HTTP 409 Conflict:
# {"error": "Table already has a pending order"}
```

---

## Fix 7: Duplicate E-Invoice Submission Prevention (Bug G)

**Bug:** `POST /api/einvoice/submit` allowed already submitted or accepted invoices to be re-submitted repeatedly to the tax authority.

**Files Changed:**
- `src/routes/einvoice.routes.js` (lines 50-59)

**Code Changes:**
```diff
--- a/src/routes/einvoice.routes.js
+++ b/src/routes/einvoice.routes.js
@@ -50,11 +50,8 @@ router.post('/submit', authenticate, async (req, res) => {
-    // BUG G: No duplicate submission check
-    // Should prevent submitting the same invoice twice
-    // Missing validation below:
-    
-    // if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
-    //   return res.status(409).json({ 
-    //     error: 'Invoice already submitted to tax authority' 
-    //   });
-    // }
+    // BUG G FIX: Prevent duplicate submissions to tax authority
+    if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
+      return res.status(409).json({ 
+        error: 'Invoice already submitted to tax authority' 
+      });
+    }
```

**Why This Fix:**
European e-invoicing platforms (such as the French PDP mandate and Chorus Pro) forbid duplicate declarations of the same legal invoice number. Sending duplicate tax submissions triggers statutory penalties, corrupted ledger balances, and rejected tax filings. The guard ensures that once an invoice status is `'submitted'` or `'accepted'`, re-submission is rejected with HTTP 409 Conflict.

**Testing:**
```bash
# First submission -> HTTP 200 { "status": "submitted", "submission_id": "SUB-..." }
# Second submission of same invoice -> HTTP 409 Conflict:
# {"error": "Invoice already submitted to tax authority"}
```
