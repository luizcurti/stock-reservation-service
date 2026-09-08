import { Pool } from 'mysql2/promise';
import { db } from '../config/database';
import {
  SelectProduct,
  searchStock,
  searchStockReserve,
  searchStockSold,
} from '../models/queryResultsTypes';
import { customError } from '../customErrors/customErrors';
import { ResultSetHeader } from 'mysql2';
import {
  responsePathStock,
  responseGetStock,
  responseInsertStockReserve,
} from '../models/responseTypes';

const DEFAULT_RESERVATION_TTL_MINUTES = 30;

export class ProductRepository {
  public db: Pool;
  public reservationTtlSeconds: number;

  constructor() {
    this.db = db;
    // Minutes, accepting fractional values (e.g. "0.05" = 3s) so tests can
    // exercise real-time expiry without a 30-minute wait. A synchronous
    // order flow normally resolves in seconds; 30 min is generous slack for
    // that, not a shopping-cart-style hold — see the stock-service README's
    // "Reservation expiry" section for why this matters under load.
    const ttlMinutes = parseFloat(
      process.env.RESERVATION_TTL_MINUTES ??
        String(DEFAULT_RESERVATION_TTL_MINUTES)
    );
    this.reservationTtlSeconds = Math.max(1, Math.round(ttlMinutes * 60));
  }

  public async searchStock(id: number): Promise<searchStock | null> {
    try {
      const [result] = await this.db.query<searchStock[]>(
        'SELECT id, product, qtd FROM IN_STOCK WHERE id = ?',
        [id]
      );

      if (result.length > 0) {
        return result[0];
      }
      return null;
    } catch {
      throw new customError(500, 'Error fetching data from IN_STOCK table.');
    }
  }

  public async getStock(id: number): Promise<responseGetStock> {
    try {
      const [result] = await this.db.query<SelectProduct[]>(
        `SELECT 
          i.id, 
          i.qtd as stock, 
          COALESCE(COUNT(DISTINCT r.reservationToken), 0) as reserve, 
          COALESCE(COUNT(DISTINCT s.reservationToken), 0) as sold
        FROM IN_STOCK as i 
        LEFT JOIN RESERVED as r ON i.id = r.id_stock
        LEFT JOIN SOLD as s ON i.id = s.id_stock 
        WHERE i.id = ?
        GROUP BY i.id, i.qtd`,
        [id]
      );

      if (result.length > 0) {
        return {
          ID: result[0].id,
          IN_STOCK: result[0].stock,
          RESERVE: result[0].reserve,
          SOLD: result[0].sold,
        };
      } else {
        throw new customError(404, 'Product not found.');
      }
    } catch (error) {
      if (error instanceof customError) {
        throw error;
      }
      throw new customError(500, 'Error fetching stock data.');
    }
  }

  public async insertStock(
    id: number,
    product: string,
    qtd: number
  ): Promise<responsePathStock> {
    try {
      await this.db.query(
        'INSERT INTO IN_STOCK (id, product, qtd) VALUES (?, ?, ?)',
        [id, product, qtd]
      );

      return {
        id: id,
        product: product,
        stock: qtd,
      };
    } catch {
      throw new customError(500, 'Error inserting data into IN_STOCK table.');
    }
  }

  public async updateStock(
    id: number,
    product: string,
    qtd: number
  ): Promise<responsePathStock> {
    try {
      const [result] = await this.db.query<ResultSetHeader>(
        'UPDATE IN_STOCK SET product = ?, qtd = ? WHERE id = ?',
        [product, qtd, id]
      );

      // Check if any rows were affected
      if (result.affectedRows === 0) {
        throw new customError(404, 'Product not found for update.');
      }

      return {
        id: id,
        product: product,
        stock: qtd,
      };
    } catch (error) {
      if (error instanceof customError) {
        throw error;
      }
      throw new customError(500, 'Error updating data in IN_STOCK table.');
    }
  }

  /**
   * Atomically reserves one unit of stock using a transaction with SELECT FOR UPDATE.
   * Prevents race conditions when multiple requests compete for the last unit.
   */
  public async reserveStock(
    id: number,
    uuid: string
  ): Promise<responseInsertStockReserve> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      const [rows] = await connection.query<searchStock[]>(
        'SELECT id, product, qtd FROM IN_STOCK WHERE id = ? FOR UPDATE',
        [id]
      );

      if (rows.length === 0) {
        throw new customError(404, 'Product not found in stock.');
      }

      const { product, qtd } = rows[0];

      if (qtd <= 0) {
        throw new customError(400, 'Insufficient stock quantity.');
      }

      await connection.query('UPDATE IN_STOCK SET qtd = ? WHERE id = ?', [
        qtd - 1,
        id,
      ]);

      await connection.query(
        'INSERT INTO RESERVED (id_stock, product, reservationToken, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
        [id, product, uuid, this.reservationTtlSeconds]
      );

      await connection.commit();

      return { id, product, reservationToken: uuid };
    } catch (error) {
      await connection.rollback();
      if (error instanceof customError) {
        throw error;
      }
      throw new customError(500, 'Error reserving stock.');
    } finally {
      connection.release();
    }
  }

  /**
   * Atomically returns a reserved unit back to stock.
   * Verifies reservation exists before modifying stock to prevent inconsistency.
   */
  public async returnStock(
    id: number,
    reservationToken: string
  ): Promise<void> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      const [reserveRows] = await connection.query<searchStockReserve[]>(
        'SELECT id_stock, product, reservationToken FROM RESERVED WHERE id_stock = ? AND reservationToken = ? FOR UPDATE',
        [id, reservationToken]
      );

      if (reserveRows.length === 0) {
        throw new customError(404, 'Reservation not found.');
      }

      const [stockRows] = await connection.query<searchStock[]>(
        'SELECT id, product, qtd FROM IN_STOCK WHERE id = ? FOR UPDATE',
        [id]
      );

      if (stockRows.length === 0) {
        throw new customError(404, 'Product not found in stock.');
      }

      const { qtd } = stockRows[0];

      await connection.query(
        'DELETE FROM RESERVED WHERE id_stock = ? AND reservationToken = ?',
        [id, reservationToken]
      );

      await connection.query('UPDATE IN_STOCK SET qtd = ? WHERE id = ?', [
        qtd + 1,
        id,
      ]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error instanceof customError) {
        throw error;
      }
      throw new customError(500, 'Error returning stock.');
    } finally {
      connection.release();
    }
  }

  /**
   * Atomically deletes a product from stock.
   * Refuses if active reservations or sales history exist.
   */
  public async deleteStock(id: number): Promise<void> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      // Locks the IN_STOCK row before checking for reservations, using the
      // same FOR UPDATE lock reserveStock takes. Without this, a reservation
      // can be created (and committed) after this method reads RESERVED as
      // empty but before it deletes the row — the ON DELETE CASCADE on
      // RESERVED then silently destroys that reservation. Taking the lock
      // first serializes the two transactions so one fully completes before
      // the other's checks run.
      const [stockRows] = await connection.query<searchStock[]>(
        'SELECT id, product, qtd FROM IN_STOCK WHERE id = ? FOR UPDATE',
        [id]
      );

      if (stockRows.length === 0) {
        throw new customError(404, 'Product not found.');
      }

      const [reserveRows] = await connection.query<searchStockReserve[]>(
        'SELECT id_stock FROM RESERVED WHERE id_stock = ? LIMIT 1',
        [id]
      );

      if (reserveRows.length > 0) {
        throw new customError(
          409,
          'Cannot delete product with active reservations.'
        );
      }

      const [soldRows] = await connection.query<searchStockSold[]>(
        'SELECT id_stock FROM SOLD WHERE id_stock = ? LIMIT 1',
        [id]
      );

      if (soldRows.length > 0) {
        throw new customError(409, 'Cannot delete product with sales history.');
      }

      await connection.query('DELETE FROM IN_STOCK WHERE id = ?', [id]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error instanceof customError) {
        throw error;
      }
      throw new customError(500, 'Error deleting product from stock.');
    } finally {
      connection.release();
    }
  }

  /**
   * Atomically marks a reservation as sold.
   * Inserts into SOLD and removes from RESERVED in a single transaction.
   */
  public async sellStock(id: number, reservationToken: string): Promise<void> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      const [rows] = await connection.query<searchStockReserve[]>(
        'SELECT id_stock, product, reservationToken FROM RESERVED WHERE id_stock = ? AND reservationToken = ? FOR UPDATE',
        [id, reservationToken]
      );

      if (rows.length === 0) {
        throw new customError(404, 'Reservation not found.');
      }

      const { product } = rows[0];

      await connection.query(
        'INSERT INTO SOLD (id_stock, product, reservationToken) VALUES (?, ?, ?)',
        [id, product, reservationToken]
      );

      await connection.query(
        'DELETE FROM RESERVED WHERE id_stock = ? AND reservationToken = ?',
        [id, reservationToken]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error instanceof customError) {
        throw error;
      }
      throw new customError(500, 'Error selling stock.');
    } finally {
      connection.release();
    }
  }

  /**
   * Returns every reservation past its expires_at back to stock, reusing
   * returnStock's transactional (FOR UPDATE) logic for each one. A
   * reservation resolved (sold/returned) concurrently since the read below
   * is skipped rather than failing the whole batch.
   */
  public async releaseExpiredReservations(): Promise<number> {
    const [rows] = await this.db.query<searchStockReserve[]>(
      'SELECT id_stock, product, reservationToken FROM RESERVED WHERE expires_at <= NOW()'
    );

    let released = 0;
    for (const row of rows) {
      try {
        await this.returnStock(row.id_stock, row.reservationToken);
        released++;
      } catch (error) {
        if (error instanceof customError && error.status === 404) {
          continue;
        }
        throw error;
      }
    }
    return released;
  }
}
