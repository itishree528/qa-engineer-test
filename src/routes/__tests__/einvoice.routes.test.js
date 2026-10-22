import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import app from '../../server.js';
import { db } from '../../db/database.js';

describe('E-Invoice Routes - Bug G', () => {
  let authToken = '';

  before(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'merchant@test.com',
        password: 'Test123!'
      });
    authToken = res.body.token;
  });

  // Bug G: Prevent duplicate e-invoice submissions
  test('Bug G: POST /api/einvoice/submit should allow initial submission of an invoice', async () => {
    const invoiceId = `inv_test_${Date.now()}`;
    const res = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        invoice_id: invoiceId,
        customer_siret: '12345678901234' // Exactly 14 digits
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.status, 'submitted');
    assert.ok(res.body.data.submission_id);

    const savedInvoice = db.invoices.find(i => i.id === invoiceId);
    assert.ok(savedInvoice);
    assert.strictEqual(savedInvoice.einvoice_status, 'submitted');
  });

  test('Bug G: POST /api/einvoice/submit should reject duplicate submission of already submitted invoice with 409', async () => {
    const invoiceId = `inv_test_${Date.now()}`;

    // First submission
    const res1 = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        invoice_id: invoiceId,
        customer_siret: '12345678901234'
      });
    assert.strictEqual(res1.status, 200);

    // Second submission (duplicate)
    const res2 = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        invoice_id: invoiceId,
        customer_siret: '12345678901234'
      });

    assert.strictEqual(res2.status, 409);
    assert.strictEqual(res2.body.error, 'Invoice already submitted to tax authority');
  });

  test('Bug G: POST /api/einvoice/submit should reject submission of an accepted invoice with 409', async () => {
    const invoiceId = `inv_accepted_${Date.now()}`;
    db.invoices.push({
      id: invoiceId,
      merchant_id: '1',
      invoice_number: `INV-${Date.now()}`,
      amount: 200,
      currency: 'EUR',
      customer_siret: '12345678901234',
      einvoice_status: 'accepted',
      created_at: new Date()
    });

    const res = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        invoice_id: invoiceId,
        customer_siret: '12345678901234'
      });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'Invoice already submitted to tax authority');
  });

  test('POST /api/einvoice/submit should reject SIRET with length not equal to 14', async () => {
    const res = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        invoice_id: `inv_siret_${Date.now()}`,
        customer_siret: '12345' // Too short
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Valid customer SIRET required for e-invoicing (14 digits)');
  });

  test('POST /api/einvoice/submit should reject missing invoice_id', async () => {
    const res = await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        customer_siret: '12345678901234'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'invoice_id required');
  });

  test('GET /api/einvoice/status/:invoice_id should return submission status for merchant invoice', async () => {
    const invoiceId = `inv_status_${Date.now()}`;
    await request(app)
      .post('/api/einvoice/submit')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        invoice_id: invoiceId,
        customer_siret: '12345678901234'
      });

    const res = await request(app)
      .get(`/api/einvoice/status/${invoiceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.invoice_id, invoiceId);
    assert.strictEqual(res.body.data.einvoice_status, 'submitted');
  });

  test('GET /api/einvoice/status/:invoice_id should return 404 for non-existent invoice', async () => {
    const res = await request(app)
      .get('/api/einvoice/status/nonexistent_invoice_id')
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Invoice not found');
  });
});
