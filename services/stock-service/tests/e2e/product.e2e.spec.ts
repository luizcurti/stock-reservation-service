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

    // Seed: product id=5 with 3 units  (mirrors Insomnia collection)
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
  // PATCH /product/:id/stock — criar ou actualizar stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('PATCH /product/:id/stock', () => {
    it('deve criar stock para um produto novo (id=20)', async () => {
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

    it('deve actualizar stock de um produto existente (id=5)', async () => {
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

    it('deve aceitar qtd = 0', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 0 })
        .expect(200);

      expect(res.body.stock).toBe(0);

      // restaura para 3
      await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball', qtd: 3 })
        .expect(200);
    });

    it('deve retornar 422 quando product está ausente no body', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ qtd: 10 })
        .expect(422);

      expect(res.body.message).toBeDefined();
    });

    it('deve retornar 422 quando qtd está ausente no body', async () => {
      const res = await api
        .patch('/product/5/stock')
        .send({ product: 'Volleyball' })
        .expect(422);

      expect(res.body.message).toBeDefined();
    });

    it('deve retornar 422 quando body está vazio', async () => {
      await api.patch('/product/5/stock').send({}).expect(422);
    });

    it('deve retornar 400 quando product é string vazia (validação do service)', async () => {
      // tsoa valida que product é string mas não verifica tamanho/empty
      // a validação de empty string está no service
      const res = await api
        .patch('/product/5/stock')
        .send({ product: '', qtd: 10 });

      expect([400, 422]).toContain(res.status);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /product/:id — consultar stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('GET /product/:id', () => {
    it('deve retornar dados do produto id=5', async () => {
      const res = await api.get('/product/5').expect(200);

      expect(res.body).toMatchObject({
        ID: 5,
        IN_STOCK: 3,
        RESERVE: 0,
        SOLD: 0,
      });
    });

    it('deve retornar 404 para produto inexistente', async () => {
      const res = await api.get('/product/9999').expect(404);

      expect(res.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /product/:id/reserve — reservar 1 unidade
  // ══════════════════════════════════════════════════════════════════════════

  describe('POST /product/:id/reserve', () => {
    it('deve criar reserva para produto com stock disponível', async () => {
      const res = await api.post('/product/5/reserve').expect(201);

      expect(res.body).toMatchObject({
        id: 5,
        product: 'Volleyball',
      });
      expect(res.body.reservationToken).toBeDefined();
      expect(typeof res.body.reservationToken).toBe('string');

      tokenReserve1 = res.body.reservationToken;
    });

    it('stock disponível deve ter diminuído em 1', async () => {
      const res = await api.get('/product/5').expect(200);
      expect(res.body.IN_STOCK).toBe(2);
      expect(res.body.RESERVE).toBe(1);
    });

    it('deve criar segunda reserva (token2)', async () => {
      const res = await api.post('/product/5/reserve').expect(201);
      tokenReserve2 = res.body.reservationToken;

      const stock = await api.get('/product/5');
      expect(stock.body.IN_STOCK).toBe(1);
      expect(stock.body.RESERVE).toBe(2);
    });

    it('deve retornar 400 quando stock é insuficiente', async () => {
      const res = await api.post('/product/10/reserve').expect(400);
      expect(res.body.message).toBe('Insufficient stock quantity.');
    });

    it('deve retornar 404 para produto sem entrada em stock', async () => {
      const res = await api.post('/product/9999/reserve').expect(404);
      expect(res.body.message).toBe('Product not found in stock.');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /product/:id/sold — marcar reserva como vendida
  // ══════════════════════════════════════════════════════════════════════════

  describe('POST /product/:id/sold', () => {
    it('deve marcar reserva como vendida usando tokenReserve1', async () => {
      await api
        .post('/product/5/sold')
        .send({ reservationToken: tokenReserve1 })
        .expect(204);
    });

    it('stock deve reflectir: RESERVE -1, SOLD +1', async () => {
      const res = await api.get('/product/5').expect(200);
      expect(res.body.RESERVE).toBe(1);
      expect(res.body.SOLD).toBe(1);
    });

    it('deve retornar 404 ao tentar vender o mesmo token novamente', async () => {
      const res = await api
        .post('/product/5/sold')
        .send({ reservationToken: tokenReserve1 })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('deve retornar 404 para token inexistente', async () => {
      const res = await api
        .post('/product/5/sold')
        .send({ reservationToken: '00000000-0000-4000-8000-000000000001' })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('deve retornar 422 quando reservationToken está ausente no body', async () => {
      const res = await api.post('/product/5/sold').send({}).expect(422);
      expect(res.body.message).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /product/:id/return — devolver reserva ao stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('POST /product/:id/return', () => {
    it('deve devolver reserva ao stock usando tokenReserve2', async () => {
      await api
        .post('/product/5/return')
        .send({ reservationToken: tokenReserve2 })
        .expect(204);
    });

    it('stock deve ter voltado: RESERVE=0, IN_STOCK=2', async () => {
      const res = await api.get('/product/5').expect(200);
      expect(res.body.RESERVE).toBe(0);
      // started at 3, sold 1 unit → committed out of stock. Returned 1 from reserve
      // state: IN_STOCK=2 (1 left in stock + 1 returned from tokenReserve2)
      expect(res.body.IN_STOCK).toBe(2);
    });

    it('deve retornar 404 ao tentar devolver o mesmo token novamente', async () => {
      const res = await api
        .post('/product/5/return')
        .send({ reservationToken: tokenReserve2 })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('deve retornar 404 para token inexistente', async () => {
      const res = await api
        .post('/product/5/return')
        .send({ reservationToken: '00000000-0000-4000-8000-000000000002' })
        .expect(404);

      expect(res.body.message).toBe('Reservation not found.');
    });

    it('deve retornar 422 quando reservationToken está ausente no body', async () => {
      await api.post('/product/5/return').send({}).expect(422);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Estado final do produto
  // ══════════════════════════════════════════════════════════════════════════

  describe('Estado final — GET /product/5', () => {
    it('deve reflectir o histórico completo do fluxo', async () => {
      const res = await api.get('/product/5').expect(200);

      // 3 inicial → reservou 2 (token1 sold, token2 returned)
      // IN_STOCK: 3 - 1 (sold, nunca volta) = 2
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
    it('deve responder 200 com status OK', async () => {
      const res = await api.get('/health').expect(200);
      expect(res.body.status).toBe('OK');
    });
  });

  describe('X-Version header', () => {
    it('deve responder com X-Version=v1 quando SERVICE_VERSION não está definido', async () => {
      const res = await api.get('/health').expect(200);
      expect(res.headers['x-version']).toBe('v1');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE /product/:id — remover produto do stock
  // ══════════════════════════════════════════════════════════════════════════

  describe('DELETE /product/:id', () => {
    const freshId = 50;
    const reservedId = 51;
    const soldId = 52;

    beforeAll(async () => {
      // Produto sem histórico — será deletado com sucesso
      await api
        .patch(`/product/${freshId}/stock`)
        .send({ product: 'DeleteMe', qtd: 5 })
        .expect(200);

      // Produto com reserva activa
      await api
        .patch(`/product/${reservedId}/stock`)
        .send({ product: 'HasReserve', qtd: 5 })
        .expect(200);
      await api.post(`/product/${reservedId}/reserve`).expect(201);

      // Produto com histórico de vendas
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

    it('deve retornar 404 para produto inexistente', async () => {
      const res = await api.delete('/product/9999').expect(404);
      expect(res.body.message).toBeDefined();
    });

    it('deve retornar 409 quando há reservas activas', async () => {
      const res = await api.delete(`/product/${reservedId}`).expect(409);
      expect(res.body.message).toMatch(/reservations/i);
    });

    it('deve retornar 409 quando há histórico de vendas', async () => {
      const res = await api.delete(`/product/${soldId}`).expect(409);
      expect(res.body.message).toMatch(/sales history/i);
    });

    it('deve eliminar produto sem histórico e retornar 204', async () => {
      await api.delete(`/product/${freshId}`).expect(204);
    });

    it('deve retornar 404 ao tentar eliminar o mesmo produto novamente', async () => {
      await api.delete(`/product/${freshId}`).expect(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Rota não existente
  // ══════════════════════════════════════════════════════════════════════════

  describe('Rota inexistente', () => {
    it('deve retornar 404 para rota desconhecida', async () => {
      await api.get('/nao-existe').expect(404);
    });
  });
});
