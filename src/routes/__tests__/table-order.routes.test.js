import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import app from '../../server.js';
import { db } from '../../db/database.js';

describe('Table Order Routes - Bug F', () => {
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

  // Bug F: Duplicate table order prevention
  test('Bug F: POST /api/table-orders should create initial pending order for a table', async () => {
    const res = await request(app)
      .post('/api/table-orders')
      .send({
        merchant_id: '1',
        table_number: 10,
        items: [
          { name: 'Burger', price: 15.0, quantity: 2 },
          { name: 'Fries', price: 5.0, quantity: 1 }
        ],
        customer_name: 'John Doe'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.table_number, 10);
    assert.strictEqual(res.body.data.status, 'pending');
    assert.strictEqual(res.body.data.total, 35.0); // 15*2 + 5*1
  });

  test('Bug F: POST /api/table-orders should reject duplicate order when table already has pending order', async () => {
    const res = await request(app)
      .post('/api/table-orders')
      .send({
        merchant_id: '1',
        table_number: 10, // Table 10 already has pending order from test above
        items: [
          { name: 'Pizza', price: 20.0, quantity: 1 }
        ],
        customer_name: 'Jane Doe'
      });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'Table already has a pending order');
  });

  test('Bug F: POST /api/table-orders should allow new order after previous order status changes from pending', async () => {
    // Find Table 10 pending order and update status to confirmed
    const order = db.table_orders.find(o => o.table_number === 10 && o.status === 'pending');
    assert.ok(order);
    order.status = 'confirmed';

    // Now Table 10 can accept a new order
    const res = await request(app)
      .post('/api/table-orders')
      .send({
        merchant_id: '1',
        table_number: 10,
        items: [{ name: 'Dessert', price: 8.0, quantity: 1 }]
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.status, 'pending');
  });

  test('POST /api/table-orders should reject missing required fields', async () => {
    const res = await request(app)
      .post('/api/table-orders')
      .send({
        merchant_id: '1',
        table_number: 99
        // items missing
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'merchant_id, table_number, and items array required');
  });

  test('POST /api/table-orders should reject empty items array', async () => {
    const res = await request(app)
      .post('/api/table-orders')
      .send({
        merchant_id: '1',
        table_number: 99,
        items: []
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Order must have at least one item');
  });

  test('GET /api/table-orders should list orders for authenticated merchant', async () => {
    const res = await request(app)
      .get('/api/table-orders')
      .set('Authorization', `Bearer ${authToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
  });

  test('PATCH /api/table-orders/:id/status should update order status with valid transition', async () => {
    const order = db.table_orders.find(o => o.merchant_id === '1');
    assert.ok(order);

    const res = await request(app)
      .patch(`/api/table-orders/${order.id}/status`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ status: 'preparing' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.status, 'preparing');
  });

  test('PATCH /api/table-orders/:id/status should reject invalid status', async () => {
    const order = db.table_orders.find(o => o.merchant_id === '1');
    assert.ok(order);

    const res = await request(app)
      .patch(`/api/table-orders/${order.id}/status`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ status: 'delivered_and_eaten' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Valid status required');
  });
});
