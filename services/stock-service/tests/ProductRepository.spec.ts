// Mock the database first
jest.mock('../src/config/database', () => ({
  db: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

import { ProductRepository } from '../src/repositories/ProductRepository';
import { customError } from '../src/customErrors/customErrors';
import { db } from '../src/config/database';

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;

describe('ProductRepository', () => {
  let repository: ProductRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new ProductRepository();
  });

  describe('constructor', () => {
    it('should create repository instance', () => {
      expect(repository).toBeInstanceOf(ProductRepository);
      expect(repository.db).toBeDefined();
    });
  });

  describe('searchStock', () => {
    it('should return stock when found', async () => {
      const mockData = { id: 1, product: 'Ball', qtd: 100 };
      mockQuery.mockResolvedValue([[mockData] as any, []]);

      const result = await repository.searchStock(1);

      expect(result).toEqual(mockData);
    });

    it('should return null when not found', async () => {
      mockQuery.mockResolvedValue([[] as any, []]);
      const result = await repository.searchStock(1);
      expect(result).toBeNull();
    });

    it('should throw customError on database error', async () => {
      mockQuery.mockRejectedValue(new Error('DB Error'));
      await expect(repository.searchStock(1)).rejects.toThrow(customError);
    });
  });

  describe('getStock', () => {
    it('should return formatted stock data when found', async () => {
      const mockData = { id: 1, stock: 100, reserve: 5, sold: 2 };
      mockQuery.mockResolvedValue([[mockData] as any, []]);

      const result = await repository.getStock(1);

      expect(result).toEqual({
        ID: 1,
        IN_STOCK: 100,
        RESERVE: 5,
        SOLD: 2,
      });
    });

    it('should throw customError when product not found', async () => {
      mockQuery.mockResolvedValue([[] as any, []]);
      await expect(repository.getStock(1)).rejects.toThrow(
        'Product not found.'
      );
    });

    it('should rethrow customError when it occurs', async () => {
      const customErr = new customError(404, 'Custom error');
      mockQuery.mockRejectedValue(customErr);

      try {
        await repository.getStock(1);
      } catch (error) {
        expect(error).toBe(customErr);
      }
    });

    it('should throw customError on general database error', async () => {
      mockQuery.mockRejectedValue(new Error('Database error'));
      await expect(repository.getStock(1)).rejects.toThrow(
        'Error fetching stock data.'
      );
    });
  });

  describe('insertStock', () => {
    it('should insert and return stock data', async () => {
      mockQuery.mockResolvedValue([{ affectedRows: 1 } as any, []]);

      const result = await repository.insertStock(1, 'Ball', 100);

      expect(result).toEqual({ id: 1, product: 'Ball', stock: 100 });
    });

    it('should throw customError on database error', async () => {
      mockQuery.mockRejectedValue(new Error('Insert failed'));
      await expect(repository.insertStock(1, 'Ball', 100)).rejects.toThrow(
        'Error inserting data into IN_STOCK table.'
      );
    });
  });

  describe('updateStock', () => {
    it('should update and return stock data', async () => {
      mockQuery.mockResolvedValue([{ affectedRows: 1 } as any, []]);

      const result = await repository.updateStock(1, 'Ball', 150);

      expect(result).toEqual({ id: 1, product: 'Ball', stock: 150 });
    });

    it('should throw error when no rows affected', async () => {
      mockQuery.mockResolvedValue([{ affectedRows: 0 } as any, []]);
      await expect(repository.updateStock(1, 'Ball', 150)).rejects.toThrow(
        'Product not found for update.'
      );
    });

    it('should rethrow customError when it occurs', async () => {
      const customErr = new customError(500, 'Update error');
      mockQuery.mockRejectedValue(customErr);

      try {
        await repository.updateStock(1, 'Ball', 150);
      } catch (error) {
        expect(error).toBe(customErr);
      }
    });

    it('should throw customError on general database error', async () => {
      mockQuery.mockRejectedValue(new Error('Update failed'));
      await expect(repository.updateStock(1, 'Ball', 150)).rejects.toThrow(
        'Error updating data in IN_STOCK table.'
      );
    });
  });

  // =====================================================
  // TRANSACTION METHODS
  // =====================================================

  function buildMockConnection() {
    return {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      query: jest.fn(),
    };
  }

  describe('reserveStock', () => {
    it('should reserve stock atomically', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query
        .mockResolvedValueOnce([[{ id: 1, product: 'Ball', qtd: 5 }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      const result = await repository.reserveStock(1, 'uuid-123');

      expect(result).toEqual({
        id: 1,
        product: 'Ball',
        reservationToken: 'uuid-123',
      });
      expect(mockConn.commit).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should rollback and throw when product not found', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockResolvedValueOnce([[], []]);

      await expect(repository.reserveStock(1, 'uuid')).rejects.toThrow(
        'Product not found in stock.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should rollback and throw when stock is insufficient', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockResolvedValueOnce([
        [{ id: 1, product: 'Ball', qtd: 0 }],
        [],
      ]);

      await expect(repository.reserveStock(1, 'uuid')).rejects.toThrow(
        'Insufficient stock quantity.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    it('should rollback and throw generic error on db failure', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockRejectedValueOnce(new Error('DB Error'));

      await expect(repository.reserveStock(1, 'uuid')).rejects.toThrow(
        'Error reserving stock.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });
  });

  describe('returnStock', () => {
    it('should return stock to inventory atomically', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query
        .mockResolvedValueOnce([
          [{ id_stock: 1, product: 'Ball', reservationToken: 'tok' }],
          [],
        ])
        .mockResolvedValueOnce([[{ id: 1, product: 'Ball', qtd: 9 }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      await repository.returnStock(1, 'tok');

      expect(mockConn.commit).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should rollback and throw when reservation not found', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockResolvedValueOnce([[], []]);

      await expect(repository.returnStock(1, 'tok')).rejects.toThrow(
        'Reservation not found.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should rollback and throw when stock row not found', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query
        .mockResolvedValueOnce([
          [{ id_stock: 1, product: 'Ball', reservationToken: 'tok' }],
          [],
        ])
        .mockResolvedValueOnce([[], []]);

      await expect(repository.returnStock(1, 'tok')).rejects.toThrow(
        'Product not found in stock.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    it('should rollback and throw generic error on db failure', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockRejectedValueOnce(new Error('DB Error'));

      await expect(repository.returnStock(1, 'tok')).rejects.toThrow(
        'Error returning stock.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
    });
  });

  describe('sellStock', () => {
    it('should mark reservation as sold atomically', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query
        .mockResolvedValueOnce([
          [{ id_stock: 1, product: 'Ball', reservationToken: 'tok' }],
          [],
        ])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      await repository.sellStock(1, 'tok');

      expect(mockConn.commit).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should rollback and throw when reservation not found', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockResolvedValueOnce([[], []]);

      await expect(repository.sellStock(1, 'tok')).rejects.toThrow(
        'Reservation not found.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should rollback and throw generic error on db failure', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockRejectedValueOnce(new Error('DB Error'));

      await expect(repository.sellStock(1, 'tok')).rejects.toThrow(
        'Error selling stock.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
    });
  });

  describe('deleteStock', () => {
    it('should delete product with no reservations or sales', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query
        .mockResolvedValueOnce([
          [{ id: 1, product: 'Ball', qtd: 5 }] as any,
          [],
        ]) // lock IN_STOCK row
        .mockResolvedValueOnce([[] as any, []]) // no reservations
        .mockResolvedValueOnce([[] as any, []]) // no sold records
        .mockResolvedValueOnce([{ affectedRows: 1 } as any, []]); // delete ok

      await expect(repository.deleteStock(1)).resolves.toBeUndefined();
      expect(mockConn.commit).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should throw 404 when product not found', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query.mockResolvedValueOnce([[] as any, []]); // lock query finds nothing

      await expect(repository.deleteStock(1)).rejects.toThrow(
        'Product not found.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should throw 409 when active reservations exist', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query
        .mockResolvedValueOnce([
          [{ id: 1, product: 'Ball', qtd: 5 }] as any,
          [],
        ]) // lock IN_STOCK row
        .mockResolvedValueOnce([[{ id_stock: 1 }] as any, []]); // has reservations

      await expect(repository.deleteStock(1)).rejects.toThrow(
        'Cannot delete product with active reservations.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('should throw 409 when sales history exists', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);

      mockConn.query
        .mockResolvedValueOnce([
          [{ id: 1, product: 'Ball', qtd: 5 }] as any,
          [],
        ]) // lock IN_STOCK row
        .mockResolvedValueOnce([[] as any, []]) // no reservations
        .mockResolvedValueOnce([[{ id_stock: 1 }] as any, []]); // has sold records

      await expect(repository.deleteStock(1)).rejects.toThrow(
        'Cannot delete product with sales history.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    it('should rethrow customError without wrapping', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      const err = new customError(409, 'Custom conflict');
      mockConn.query.mockRejectedValueOnce(err);

      await expect(repository.deleteStock(1)).rejects.toBe(err);
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    it('should throw 500 on unexpected database error', async () => {
      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockRejectedValueOnce(new Error('Unexpected DB failure'));

      await expect(repository.deleteStock(1)).rejects.toThrow(
        'Error deleting product from stock.'
      );
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });
  });

  describe('releaseExpiredReservations', () => {
    it('should return each expired reservation to stock and report the count', async () => {
      mockQuery.mockResolvedValueOnce([
        [
          { id_stock: 1, product: 'Ball', reservationToken: 'tok-1' },
          { id_stock: 2, product: 'Bat', reservationToken: 'tok-2' },
        ] as any,
        [],
      ]);

      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query
        // returnStock(1, 'tok-1')
        .mockResolvedValueOnce([
          [{ id_stock: 1, product: 'Ball', reservationToken: 'tok-1' }],
          [],
        ])
        .mockResolvedValueOnce([[{ id: 1, product: 'Ball', qtd: 4 }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        // returnStock(2, 'tok-2')
        .mockResolvedValueOnce([
          [{ id_stock: 2, product: 'Bat', reservationToken: 'tok-2' }],
          [],
        ])
        .mockResolvedValueOnce([[{ id: 2, product: 'Bat', qtd: 9 }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      const released = await repository.releaseExpiredReservations();

      expect(released).toBe(2);
      expect(mockConn.commit).toHaveBeenCalledTimes(2);
    });

    it('should skip a reservation already resolved concurrently', async () => {
      mockQuery.mockResolvedValueOnce([
        [{ id_stock: 1, product: 'Ball', reservationToken: 'tok-1' }] as any,
        [],
      ]);

      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      // returnStock finds nothing — already sold/returned since the read above
      mockConn.query.mockResolvedValueOnce([[], []]);

      const released = await repository.releaseExpiredReservations();

      expect(released).toBe(0);
      expect(mockConn.rollback).toHaveBeenCalled();
    });

    it('should propagate an unexpected error instead of silently skipping it', async () => {
      mockQuery.mockResolvedValueOnce([
        [{ id_stock: 1, product: 'Ball', reservationToken: 'tok-1' }] as any,
        [],
      ]);

      const mockConn = buildMockConnection();
      (db.getConnection as jest.Mock).mockResolvedValue(mockConn);
      mockConn.query.mockRejectedValueOnce(new Error('DB Error'));

      await expect(repository.releaseExpiredReservations()).rejects.toThrow(
        'Error returning stock.'
      );
    });

    it('should return 0 when nothing is expired', async () => {
      mockQuery.mockResolvedValueOnce([[] as any, []]);

      const released = await repository.releaseExpiredReservations();

      expect(released).toBe(0);
      expect(db.getConnection).not.toHaveBeenCalled();
    });
  });
});
