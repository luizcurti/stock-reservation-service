import request from 'supertest';
import mysql2, { Connection } from 'mysql2/promise';
import { app } from '../../app';
import { ProductService } from '../../src/services/ProductService';

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

// The SQL schema carries an expires_at column on RESERVED so a reservation
// that's never sold or returned (e.g. order-service crashes mid-flow) isn't
// stuck forever. ProductService.releaseExpiredReservations() — driven in
// production by src/config/reservationExpiryScheduler.ts — is what actually
// honors that column; these tests prove it against real MySQL.
describe('Reservation expiry — releaseExpiredReservations (real MySQL)', () => {
  const productId = 950;
  let conn: Connection | null = null;

  beforeAll(async () => {
    conn = await getConnection();
  });

  afterAll(async () => {
    if (conn) await conn.end();
  });

  it('returns only expired reservations to stock, leaving active ones untouched', async () => {
    await seedProduct(conn!, productId, 'Expiry Widget', 2);

    const active = await api.post(`/product/${productId}/reserve`).expect(201);
    const expired = await api.post(`/product/${productId}/reserve`).expect(201);

    await conn!.query(
      'UPDATE RESERVED SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id_stock = ? AND reservationToken = ?',
      [productId, expired.body.reservationToken]
    );

    const released = await new ProductService().releaseExpiredReservations();
    expect(released).toBeGreaterThanOrEqual(1);

    const final = await api.get(`/product/${productId}`).expect(200);
    expect(final.body.IN_STOCK).toBe(1);
    expect(final.body.RESERVE).toBe(1);

    // The expired token is gone...
    await api
      .post(`/product/${productId}/sold`)
      .send({ reservationToken: expired.body.reservationToken })
      .expect(404);

    // ...but the still-active one is untouched and usable.
    await api
      .post(`/product/${productId}/sold`)
      .send({ reservationToken: active.body.reservationToken })
      .expect(204);
  });

  it('is a no-op when nothing is expired', async () => {
    await seedProduct(conn!, productId, 'Expiry Widget', 1);
    await api.post(`/product/${productId}/reserve`).expect(201);

    const released = await new ProductService().releaseExpiredReservations();
    expect(released).toBe(0);

    const final = await api.get(`/product/${productId}`).expect(200);
    expect(final.body.RESERVE).toBe(1);
  });

  it('stamps a fresh reservation with RESERVATION_TTL_MINUTES, not the column default of 24h', async () => {
    await seedProduct(conn!, productId, 'Expiry Widget', 1);
    const reserved = await api
      .post(`/product/${productId}/reserve`)
      .expect(201);

    const [rows] = await conn!.query<mysql2.RowDataPacket[]>(
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), expires_at) as secondsUntilExpiry FROM RESERVED WHERE reservationToken = ?',
      [reserved.body.reservationToken]
    );

    const ttlMinutes = parseFloat(process.env.RESERVATION_TTL_MINUTES ?? '30');
    const expectedSeconds = Math.max(1, Math.round(ttlMinutes * 60));
    const secondsUntilExpiry = rows[0].secondsUntilExpiry as number;

    // Within a few seconds of the configured TTL — nowhere near 24h (86400s).
    expect(secondsUntilExpiry).toBeGreaterThan(expectedSeconds - 10);
    expect(secondsUntilExpiry).toBeLessThan(expectedSeconds + 10);
  });
});
