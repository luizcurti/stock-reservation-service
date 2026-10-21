import request from 'supertest';
import mysql2, { Connection } from 'mysql2/promise';
import { app } from '../../app';

// ─── Helpers ────────────────────────────────────────────────────────────────

const api = request(app);

async function getConnection(): Promise<Connection> {
  return mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'stock_test',
  });
}

async function seedProduct(
  conn: Connection,
  id: number,
  product: string,
  qtd: number
): Promise<void> {
  await conn.query('DELETE FROM SOLD WHERE id_stock = ?', [id]);
  await conn.query('DELETE FROM RESERVED WHERE id_stock = ?', [id]);
  await conn.query('DELETE FROM IN_STOCK WHERE id = ?', [id]);
  await conn.query('INSERT INTO IN_STOCK (id, product, qtd) VALUES (?, ?, ?)', [
    id,
    product,
    qtd,
  ]);
}

// ─── E2E Suite ───────────────────────────────────────────────────────────────
//
// These tests exist to prove the one claim the README makes about this
// project: that reserve/sell/return run inside `SELECT ... FOR UPDATE`
// transactions, so concurrent requests on the same product can't race each
// other into overselling or double-processing a reservation. Every other
// test in this suite calls the API sequentially — none of them would fail if
// the `FOR UPDATE` clause were silently removed. These fire real concurrent
// requests against a real MySQL instance so a regression there is actually
// caught.

describe('Product API — Concurrency (real races against MySQL)', () => {
  let conn: Connection | null = null;

  beforeAll(async () => {
    conn = await getConnection();
  });

  afterAll(async () => {
    if (conn) await conn.end();
  });

  describe('POST /product/:id/reserve — concurrent reservations', () => {
    const productId = 901;
    const initialQty = 5;
    const concurrentRequests = 15;

    beforeAll(async () => {
      await seedProduct(conn!, productId, 'Concurrency Ball', initialQty);
    });

    it(`allows exactly ${initialQty} of ${concurrentRequests} simultaneous reservations to succeed, never oversells`, async () => {
      const responses = await Promise.all(
        Array.from({ length: concurrentRequests }, () =>
          api.post(`/product/${productId}/reserve`)
        )
      );

      const succeeded = responses.filter(res => res.status === 201);
      const rejected = responses.filter(res => res.status === 400);

      expect(succeeded).toHaveLength(initialQty);
      expect(rejected).toHaveLength(concurrentRequests - initialQty);
      rejected.forEach(res => {
        expect(res.body.message).toBe('Insufficient stock quantity.');
      });

      // Every successful reservation must carry a distinct token — if the
      // transaction ever let two requests read the same row before either
      // wrote back, this is where a duplicate would show up.
      const tokens = succeeded.map(res => res.body.reservationToken);
      expect(new Set(tokens).size).toBe(tokens.length);

      const final = await api.get(`/product/${productId}`).expect(200);
      expect(final.body.IN_STOCK).toBe(0);
      expect(final.body.RESERVE).toBe(initialQty);
    });
  });

  describe('POST /product/:id/sold — concurrent sell of the same reservation', () => {
    const productId = 902;

    it('lets only one of several simultaneous sell attempts on the same token succeed', async () => {
      await seedProduct(conn!, productId, 'Race Condition Widget', 1);

      const reserveRes = await api
        .post(`/product/${productId}/reserve`)
        .expect(201);
      const { reservationToken } = reserveRes.body;

      const attempts = 5;
      const responses = await Promise.all(
        Array.from({ length: attempts }, () =>
          api.post(`/product/${productId}/sold`).send({ reservationToken })
        )
      );

      const succeeded = responses.filter(res => res.status === 204);
      const notFound = responses.filter(res => res.status === 404);

      expect(succeeded).toHaveLength(1);
      expect(notFound).toHaveLength(attempts - 1);

      const final = await api.get(`/product/${productId}`).expect(200);
      expect(final.body.SOLD).toBe(1);
      expect(final.body.RESERVE).toBe(0);
    });
  });

  describe('DELETE /product/:id — concurrent reserve vs delete', () => {
    const productId = 903;

    it('never lets a reservation succeed and then vanish under a concurrent delete', async () => {
      // Runs several rounds since the race depends on interleaving timing —
      // any single round finding both a 201 reserve and a 204 delete proves
      // the ON DELETE CASCADE silently destroyed a reservation the caller
      // was told succeeded.
      for (let round = 0; round < 15; round++) {
        await seedProduct(conn!, productId, 'Race Delete Widget', 3);

        const [reserveRes, deleteRes] = await Promise.all([
          api.post(`/product/${productId}/reserve`),
          api.delete(`/product/${productId}`),
        ]);

        const reservationSucceeded = reserveRes.status === 201;
        const deleteSucceeded = deleteRes.status === 204;

        expect(reservationSucceeded && deleteSucceeded).toBe(false);

        if (reservationSucceeded) {
          // A reservation that "won" must still be resolvable afterwards.
          await api
            .post(`/product/${productId}/return`)
            .send({ reservationToken: reserveRes.body.reservationToken })
            .expect(204);
        }
      }
    });
  });
});
