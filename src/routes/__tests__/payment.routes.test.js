import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import app from '../../server.js';

describe('Payment Routes - Bug A & Bug B', () => {
  let authToken = '';

  before(async () => {
    // Authenticate test merchant
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'merchant@test.com',
        password: 'Test123!'
      });
    authToken = res.body.token;
  });

  // Bug A: Amount returned as number, not string
  test('Bug A: GET /api/payments should return amount as number, not string', async () => {
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length > 0);

    const firstPayment = res.body.data[0];
    assert.strictEqual(typeof firstPayment.amount, 'number', 'amount must be a number');
    assert.strictEqual(firstPayment.amount, 25.5);
  });

  test('Bug A: GET /api/payments/:id should return amount as number, not string', async () => {
    const res = await request(app)
      .get('/api/payments/1')
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(typeof res.body.data.amount, 'number', 'amount must be a number');
    assert.strictEqual(res.body.data.amount, 25.5);
  });

  // Bug B: Maximum amount limit (€50,000)
  test('Bug B: POST /api/payments should reject amount exceeding €50,000', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        amount: 999999999,
        currency: 'EUR',
        customer_email: 'whale@test.com'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Amount exceeds maximum limit of €50,000');
  });

  test('Bug B: POST /api/payments should accept valid amount within €50,000 limit', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        amount: 500,
        currency: 'EUR',
        customer_email: 'customer@test.com'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(typeof res.body.data.amount, 'number');
    assert.strictEqual(res.body.data.amount, 500);
    assert.strictEqual(res.body.data.currency, 'EUR');
  });

  test('POST /api/payments should reject negative or zero amount', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        amount: -10,
        currency: 'EUR',
        customer_email: 'customer@test.com'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Valid amount is required');
  });

  test('POST /api/payments should reject invalid currency', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        amount: 100,
        currency: 'XYZ',
        customer_email: 'customer@test.com'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Valid currency is required (EUR, USD, GBP)');
  });

  test('POST /api/payments should reject missing authentication token', async () => {
    const res = await request(app)
      .post('/api/payments')
      .send({
        amount: 100,
        currency: 'EUR',
        customer_email: 'customer@test.com'
      });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Authentication required');
  });

  test('GET /api/payments/:id should return 404 for non-existent payment', async () => {
    const res = await request(app)
      .get('/api/payments/99999')
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Payment not found');
  });
});
