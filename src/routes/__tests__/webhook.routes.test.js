import { test, describe } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import request from 'supertest';
import app from '../../server.js';
import { db } from '../../db/database.js';

const WEBHOOK_SECRET = 'test-webhook-secret-key';

function createSignature(payload) {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
}

describe('Webhook Routes - Bug D & Bug E', () => {
  // Bug D: Webhook signature verification
  test('Bug D: POST /api/webhooks/payment-status should reject missing signature with 401', async () => {
    const payload = {
      payment_id: '1',
      status: 'completed',
      event_id: 'evt_no_sig'
    };

    const res = await request(app)
      .post('/api/webhooks/payment-status')
      .send(payload);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid signature');
  });

  test('Bug D: POST /api/webhooks/payment-status should reject invalid/tampered signature with 401', async () => {
    const payload = {
      payment_id: '1',
      status: 'completed',
      event_id: 'evt_bad_sig'
    };

    const res = await request(app)
      .post('/api/webhooks/payment-status')
      .set('x-webhook-signature', 'forged-fake-signature-12345')
      .send(payload);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid signature');
  });

  test('Bug D: POST /api/webhooks/payment-status should accept valid HMAC signature and update payment status', async () => {
    const payload = {
      payment_id: '2',
      status: 'completed',
      event_id: `evt_valid_${Date.now()}`
    };
    const signature = createSignature(payload);

    const res = await request(app)
      .post('/api/webhooks/payment-status')
      .set('x-webhook-signature', signature)
      .send(payload);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.new_status, 'completed');

    // Verify payment status updated in db
    const payment = db.payments.find(p => p.id === '2');
    assert.strictEqual(payment.status, 'completed');
    assert.ok(payment.webhook_received_at);
  });

  // Bug E: Webhook idempotency
  test('Bug E: POST /api/webhooks/payment-status should return "Already processed" for duplicate event_id', async () => {
    const eventId = `evt_idempotent_${Date.now()}`;
    const payload = {
      payment_id: '1',
      status: 'completed',
      event_id: eventId
    };
    const signature = createSignature(payload);

    // First delivery
    const res1 = await request(app)
      .post('/api/webhooks/payment-status')
      .set('x-webhook-signature', signature)
      .send(payload);

    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.message, 'Webhook processed');

    // Duplicate delivery
    const res2 = await request(app)
      .post('/api/webhooks/payment-status')
      .set('x-webhook-signature', signature)
      .send(payload);

    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.message, 'Already processed');
  });

  test('POST /api/webhooks/payment-status should return 400 when payment_id or status is missing', async () => {
    const payload = {
      event_id: 'evt_missing_fields'
    };
    const signature = createSignature(payload);

    const res = await request(app)
      .post('/api/webhooks/payment-status')
      .set('x-webhook-signature', signature)
      .send(payload);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'payment_id and status required');
  });

  test('POST /api/webhooks/payment-status should return 404 for non-existent payment_id', async () => {
    const payload = {
      payment_id: '99999',
      status: 'completed',
      event_id: `evt_not_found_${Date.now()}`
    };
    const signature = createSignature(payload);

    const res = await request(app)
      .post('/api/webhooks/payment-status')
      .set('x-webhook-signature', signature)
      .send(payload);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Payment not found');
  });

  // E-invoice Webhook
  test('POST /api/webhooks/e-invoice should update invoice status from tax authority', async () => {
    // Seed an invoice first
    db.invoices.push({
      id: 'inv_webhook_test',
      merchant_id: '1',
      invoice_number: 'INV-101',
      amount: 150,
      currency: 'EUR',
      status: 'draft',
      einvoice_status: 'submitted',
      created_at: new Date()
    });

    const res = await request(app)
      .post('/api/webhooks/e-invoice')
      .send({
        invoice_id: 'inv_webhook_test',
        status: 'accepted',
        submission_id: 'SUB-12345',
        tax_authority_id: 'TAX-FR-9988'
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'accepted');

    const updated = db.invoices.find(i => i.id === 'inv_webhook_test');
    assert.strictEqual(updated.einvoice_status, 'accepted');
    assert.strictEqual(updated.tax_authority_id, 'TAX-FR-9988');
  });

  test('POST /api/webhooks/e-invoice should reject missing invoice_id or status with 400', async () => {
    const res = await request(app)
      .post('/api/webhooks/e-invoice')
      .send({
        status: 'accepted'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'invoice_id and status required');
  });
});
