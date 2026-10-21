import request from 'supertest';
import mysql2, { Connection } from 'mysql2/promise';
import { app } from '../../app';

// ─── Helpers ────────────────────────────────────────────────────────────────

const api = request(app);

async function getConnection(): Promise<Connection> {
  return mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    // Use root for test data management
    user: 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'stock_test',
  });
}

async function cleanDB(conn: Connection): Promise<void> {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  await conn.query('TRUNCATE TABLE SOLD');
  await conn.query('TRUNCATE TABLE RESERVED');
  await conn.query('TRUNCATE TABLE IN_STOCK');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

// ─── E2E Suite ───────────────────────────────────────────────────────────────

describe('Product API — E2E', () => {
  let conn: Connection | null = null;

  // tokens captured mid-test and reused in subsequent tests
  let tokenReserve1: string;
  let tokenReserve2: string;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    conn = await getConnection();
    await cleanDB(conn);

    // Seed: product id=5 with 3 units  (mirrors the README examples)
    await conn.query(
      'INSERT INTO IN_STOCK (id, product, qtd) VALUES (5, "Volleyball", 3)'
    );
    // Seed: product id=10 with 0 units (for "insufficient stock" test)
    await conn.query(
      'INSERT INTO IN_STOCK (id, product, qtd) VALUES (10, "EmptyProduct", 0)'
    );
  });

  afterAll(async () => {
    if (conn) await conn.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PATCH /product/:id/stock — create or update stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('PATCH /product/:id/stock', () => {
    it('creates stock for a new product (id=20)', async () => {
      const res = await api
        .patch('/product/20/stock')
        .send({ product: 'Tennis Ball', qtd: 50 })
        .expect(200);

      expect(res.body).toMatchObject({
        id: 20,
        product: 'Tennis Ball',
        stock: 50,
      });
    });

    it('updates stock of an existing product (id=5)', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 5 })
        .expect(200);

      expect(res.body).toMatchObject({
        id: 5,
        product: 'Volleyball',
        stock: 5,
      });
    });

    it('accepts qtd = 0', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 0 })
        .expect(200);

      expect(res.body.stock).toBe(0);

      // restore to 3
      await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 3 })
        .expect(200);
    });

    it('returns 422 when product is missing from the body', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ qtd: 10 })
        .expect(422);

      expect(res.body.message).toBeDefined();
    });

    it('returns 422 when qtd is missing from the body', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball' })
        .expect(422);

      expect(res.body.message).toBeDefined();
    });

    it('returns 422 when the body is empty', async () => {
      await api.patch('/product/5/stock').send({}).expect(422);
    });

    it('returns 400 when product is an empty string (service-level validation)', async () => {
      // tsoa only checks that product is a string; emptiness is a business
      // rule enforced in ProductService.
      const res = await api
        .patch('/product/5/stock')
        .send({ product: '', qtd: 10 })
        .expect(400);

      expect(res.body.message).toBe(
        'Product name is required and must be a string.'
      );
    });

    it('returns 400 when qtd is fractional', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 2.5 })
        .expect(400);

      expect(res.body.message).toBe('Quantity must be a non-negative integer.');
    });

    it('returns 422 when the body has unknown properties', async () => {
      await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 3, color: 'red' })
        .expect(422);
    });

    it('returns 400 for a malformed JSON body', async () => {
      const res = await api
        .patch('/product/5/stock')
        .set('Content-Type', 'application/json')
        .send('{"product": ')
        .expect(400);

      expect(res.body.message).toBe('Malformed JSON body');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /product/:id — read stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('GET /product/:id', () => {
    it('returns the stock summary of product id=5', async () => {
      const res = await api.get('/product/5').expect(200);

      expect(res.body).toMatchObject({
        ID: 5,
        IN_STOCK: 3,
        RESERVE: 0,
        SOLD: 0,
      });
    });

    it('returns 404 for a non-existent product', async () => {
      const res = await api.get('/product/9999').expect(404);

      expect(res.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /product/:id/reserve — reserve 1 unit
  // ══════════════════════════════════════════════════════════════════════════

  describe('POST /product/:id/reserve', () => {
    it('creates a reservation when stock is available', async () => {
      const res = await api.post('/product/5/reserve').expect(201);

      expect(res.body).toMatchObject({
        id: 5,
        product: 'Volleyball',
      });
      expect(res.body.reservationToken).toBeDefined();
      expect(typeof res.body.reservationToken).toBe('string');

      tokenReserve1 = res.body.reservationToken;
    });

    it('decrements available stock by 1', async () => {
      const res = await api.get('/product/5').expect(200);
      expect(res.body.IN_STOCK).toBe(2);
      expect(res.body.RESERVE).toBe(1);
    });

    it('creates a second reservation (token2)', async () => {
      const res = await api.post('/product/5/reserve').expect(201);
      tokenReserve2 = res.body.reservationToken;

      const stock = await api.get('/product/5');
      expect(stock.body.IN_STOCK).toBe(1);
      expect(stock.body.RESERVE).toBe(2);
    });

    it('returns 400 when stock is insufficient', async () => {
      const res = await api.post('/product/10/reserve').expect(400);
      expect(res.body.message).toBe('Insufficient stock quantity.');
    });

    it('returns 404 for a product with no stock entry', async () => {
      const res = await api.post('/product/9999/reserve').expect(404);
      expect(res.body.message).toBe('Product not found in stock.');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /product/:id/sold — mark a reservation as sold
  // ══════════════════════════════════════════════════════════════════════════

  describe('POST /product/:id/sold', () => {
    it('marks the reservation as sold using tokenReserve1', async () => {
      await api
        .post('/product/5/sold')
        .send({ reservationToken: tokenReserve1 })
        .expect(204);
    });

    it('reflects RESERVE -1, SOLD +1', async () => {
      const res = await api.get('/product/5').expect(200);
      expect(res.body.RESERVE).toBe(1);
      expect(res.body.SOLD).toBe(1);
    });

    it('returns 404 when selling the same token again', async () => {
      const res = await api
        .post('/product/5/sold')
        .send({ reservationToken: tokenReserve1 })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('returns 404 for an unknown token', async () => {
      const res = await api
        .post('/product/5/sold')
        .send({ reservationToken: '00000000-0000-4000-8000-000000000001' })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('returns 422 when reservationToken is missing from the body', async () => {
      const res = await api.post('/product/5/sold').send({}).expect(422);
      expect(res.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /product/:id/return — return a reservation to stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('POST /product/:id/return', () => {
    it('returns the reservation to stock using tokenReserve2', async () => {
      await api
        .post('/product/5/return')
        .send({ reservationToken: tokenReserve2 })
        .expect(204);
    });

    it('restores stock: RESERVE=0, IN_STOCK=2', async () => {
      const res = await api.get('/product/5').expect(200);
      expect(res.body.RESERVE).toBe(0);
      // started at 3, sold 1 unit → committed out of stock. Returned 1 from reserve
      // state: IN_STOCK=2 (1 left in stock + 1 returned from tokenReserve2)
      expect(res.body.IN_STOCK).toBe(2);
    });

    it('returns 404 when returning the same token again', async () => {
      const res = await api
        .post('/product/5/return')
        .send({ reservationToken: tokenReserve2 })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('returns 404 for an unknown token', async () => {
      const res = await api
        .post('/product/5/return')
        .send({ reservationToken: '00000000-0000-4000-8000-000000000002' })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('returns 422 when reservationToken is missing from the body', async () => {
      await api.post('/product/5/return').send({}).expect(422);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Final product state
  // ══════════════════════════════════════════════════════════════════════════

  describe('Final state — GET /product/5', () => {
    it('reflects the full history of the flow', async () => {
      const res = await api.get('/product/5').expect(200);

      // Started with 3 → reserved 2 (token1 sold, token2 returned)
      // IN_STOCK: 3 - 1 (sold, never comes back) = 2
      // RESERVE: 0
      // SOLD: 1
      expect(res.body).toMatchObject({
        ID: 5,
        IN_STOCK: 2,
        RESERVE: 0,
        SOLD: 1,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Health check
  // ══════════════════════════════════════════════════════════════════════════

  describe('GET /health', () => {
    it('responds 200 with status OK', async () => {
      const res = await api.get('/health').expect(200);
      expect(res.body.status).toBe('OK');
    });
  });

  describe('X-Version header', () => {
    it('responds with X-Version=v1 when SERVICE_VERSION is unset', async () => {
      const res = await api.get('/health').expect(200);
      expect(res.headers['x-version']).toBe('v1');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE /product/:id — remove a product
  // ══════════════════════════════════════════════════════════════════════════

  describe('DELETE /product/:id', () => {
    const freshId = 50;
    const reservedId = 51;
    const soldId = 52;

    beforeAll(async () => {
      // Product without history — deletion succeeds
      await api
        .patch(`/product/${freshId}/stock`)
        .send({ product: 'DeleteMe', qtd: 5 })
        .expect(200);

      // Product with an active reservation
      await api
        .patch(`/product/${reservedId}/stock`)
        .send({ product: 'HasReserve', qtd: 5 })
        .expect(200);
      await api.post(`/product/${reservedId}/reserve`).expect(201);

      // Product with sales history
      await api
        .patch(`/product/${soldId}/stock`)
        .send({ product: 'HasSold', qtd: 5 })
        .expect(200);
      const resReserve = await api
        .post(`/product/${soldId}/reserve`)
        .expect(201);
      await api
        .post(`/product/${soldId}/sold`)
        .send({ reservationToken: resReserve.body.reservationToken })
        .expect(204);
    });

    it('returns 404 for a non-existent product', async () => {
      const res = await api.delete('/product/9999').expect(404);
      expect(res.body.message).toBeDefined();
    });

    it('returns 409 when there are active reservations', async () => {
      const res = await api.delete(`/product/${reservedId}`).expect(409);
      expect(res.body.message).toMatch(/reservations/i);
    });

    it('returns 409 when there is sales history', async () => {
      const res = await api.delete(`/product/${soldId}`).expect(409);
      expect(res.body.message).toMatch(/sales history/i);
    });

    it('deletes a product without history and returns 204', async () => {
      await api.delete(`/product/${freshId}`).expect(204);
    });

    it('returns 404 when deleting the same product again', async () => {
      await api.delete(`/product/${freshId}`).expect(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Unknown route
  // ══════════════════════════════════════════════════════════════════════════

  describe('Unknown route', () => {
    it('returns 404 for an unknown route', async () => {
      await api.get('/does-not-exist').expect(404);
    });
  });
});
