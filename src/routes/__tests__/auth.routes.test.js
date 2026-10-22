import { test, describe } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import app from '../../server.js';

describe('Auth Routes - Bug C & Authentication Flow', () => {
  // Bug C: Email validation regex too permissive
  test('Bug C: POST /api/auth/register should reject email without TLD (e.g. user@domain)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'user@domain',
        password: 'Password123!',
        business_name: 'Test Business'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid email format');
  });

  test('Bug C: POST /api/auth/register should reject email without domain extension', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'merchant@localhost',
        password: 'Password123!',
        business_name: 'Test Business'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid email format');
  });

  test('Bug C: POST /api/auth/register should accept valid email with proper TLD', async () => {
    const uniqueEmail = `test_${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: uniqueEmail,
        password: 'Password123!',
        business_name: 'Valid Merchant Co'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message, 'Registration successful');
    assert.ok(res.body.token);
    assert.strictEqual(res.body.user.email, uniqueEmail);
  });

  test('POST /api/auth/register should reject password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: `short_pw_${Date.now()}@example.com`,
        password: 'short',
        business_name: 'Valid Merchant Co'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Password must be at least 8 characters');
  });

  test('POST /api/auth/register should reject missing or empty business name', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: `no_biz_${Date.now()}@example.com`,
        password: 'Password123!',
        business_name: ' '
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Business name is required');
  });

  test('POST /api/auth/register should reject already registered email with 409 Conflict', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'merchant@test.com', // Seeded merchant
        password: 'Password123!',
        business_name: 'Duplicate Merchant'
      });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'Email already registered');
  });

  test('POST /api/auth/login should successfully authenticate with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'merchant@test.com',
        password: 'Test123!'
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.message, 'Login successful');
    assert.ok(res.body.token);
    assert.strictEqual(typeof res.body.token, 'string');
    assert.strictEqual(res.body.user.email, 'merchant@test.com');
  });

  test('POST /api/auth/login should reject incorrect password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'merchant@test.com',
        password: 'WrongPassword!'
      });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
  });

  test('POST /api/auth/login should reject non-existent user with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'nonexistent@nowhere.com',
        password: 'Test123!'
      });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
  });

  test('POST /api/auth/login should reject request with missing email or password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'merchant@test.com'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Email and password required');
  });
});
