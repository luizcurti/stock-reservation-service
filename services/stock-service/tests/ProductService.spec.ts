import { ProductService } from '../src/services/ProductService';
import { ProductRepository } from '../src/repositories/ProductRepository';
import { customError } from '../src/customErrors/customErrors';

const VALID_TOKEN = 'a1b2c3d4-e5f6-4789-8012-a1b2c3d4e5f6';

describe('ProductService', () => {
  let productService: ProductService;
  let mockRepository: jest.Mocked<ProductRepository>;

  function createMockRepo(): jest.Mocked<ProductRepository> {
    return {
      db: {} as any,
      reservationTtlSeconds: 1800,
      searchStock: jest.fn(),
      insertStock: jest.fn(),
      updateStock: jest.fn(),
      getStock: jest.fn(),
      reserveStock: jest.fn(),
      returnStock: jest.fn(),
      sellStock: jest.fn(),
      deleteStock: jest.fn(),
      releaseExpiredReservations: jest.fn(),
    } as jest.Mocked<ProductRepository>;
  }

  beforeEach(() => {
    mockRepository = createMockRepo();
    productService = new ProductService(mockRepository);
  });

  // =======================================================
  // PATCH STOCK
  // =======================================================
  describe('patchStock', () => {
    it('should create new stock when product does not exist', async () => {
      mockRepository.searchStock.mockResolvedValue(null);
      mockRepository.insertStock.mockResolvedValue({
        id: 1,
        product: 'Ball',
        stock: 200,
      });

      const result = await productService.patchStock(1, {
        product: 'Ball',
        qtd: 200,
      });

      expect(result).toEqual({ id: 1, product: 'Ball', stock: 200 });
      expect(mockRepository.insertStock).toHaveBeenCalledWith(1, 'Ball', 200);
    });

    it('should update existing stock', async () => {
      mockRepository.searchStock.mockResolvedValue({
        id: 1,
        product: 'Ball',
        qtd: 10,
      } as any);
      mockRepository.updateStock.mockResolvedValue({
        id: 1,
        product: 'Ball',
        stock: 200,
      });

      const result = await productService.patchStock(1, {
        product: 'Ball',
        qtd: 200,
      });

      expect(result.stock).toBe(200);
      expect(mockRepository.updateStock).toHaveBeenCalledWith(1, 'Ball', 200);
    });

    it('should trim product name whitespace', async () => {
      mockRepository.searchStock.mockResolvedValue(null);
      mockRepository.insertStock.mockResolvedValue({
        id: 1,
        product: 'Ball',
        stock: 10,
      });

      await productService.patchStock(1, { product: '  Ball  ', qtd: 10 });

      expect(mockRepository.insertStock).toHaveBeenCalledWith(1, 'Ball', 10);
    });

    it('should use default repository when not provided', async () => {
      const service = new ProductService();
      await expect(
        service.patchStock(0, { product: 'Ball', qtd: 10 })
      ).rejects.toThrow('Invalid product ID.');
    });

    it('should throw when id is 0', async () => {
      await expect(
        productService.patchStock(0, { product: 'Ball', qtd: 10 })
      ).rejects.toThrow('Invalid product ID.');
    });

    it('should throw when id is negative', async () => {
      await expect(
        productService.patchStock(-1, { product: 'Ball', qtd: 10 })
      ).rejects.toThrow('Invalid product ID.');
    });

    it('should throw when id is not an integer', async () => {
      await expect(
        productService.patchStock(1.5, { product: 'Ball', qtd: 10 })
      ).rejects.toThrow('Invalid product ID.');
    });

    it('should throw when body is null', async () => {
      await expect(productService.patchStock(1, null as any)).rejects.toThrow(
        'Invalid request body.'
      );
    });

    it('should throw when product is empty string', async () => {
      await expect(
        productService.patchStock(1, { product: '', qtd: 10 })
      ).rejects.toThrow('Product name is required and must be a string.');
    });

    it('should throw when product is not a string', async () => {
      await expect(
        productService.patchStock(1, { product: 123 as any, qtd: 10 })
      ).rejects.toThrow('Product name is required and must be a string.');
    });

    it('should throw when product exceeds 100 characters', async () => {
      await expect(
        productService.patchStock(1, { product: 'a'.repeat(101), qtd: 10 })
      ).rejects.toThrow('Product name must be at most 100 characters.');
    });

    it('should throw when quantity is undefined', async () => {
      await expect(
        productService.patchStock(1, { product: 'Ball', qtd: undefined as any })
      ).rejects.toThrow('Quantity is required.');
    });

    it('should throw when quantity is negative', async () => {
      await expect(
        productService.patchStock(1, { product: 'Ball', qtd: -1 })
      ).rejects.toThrow('Quantity must be a non-negative number.');
    });

    it('should throw when quantity is not a number string', async () => {
      await expect(
        productService.patchStock(1, { product: 'Ball', qtd: 'invalid' as any })
      ).rejects.toThrow('Quantity must be a non-negative number.');
    });

    it('should propagate repo error', async () => {
      mockRepository.searchStock.mockRejectedValue(new Error('Database error'));
      await expect(
        productService.patchStock(1, { product: 'Ball', qtd: 10 })
      ).rejects.toThrow('Database error');
    });
  });

  // =======================================================
  // GET STOCK
  // =======================================================
  describe('getStock', () => {
    it('should return stock info', async () => {
      const expected = { ID: 1, IN_STOCK: 10, RESERVE: 2, SOLD: 5 };
      mockRepository.getStock.mockResolvedValue(expected);

      const result = await productService.getStock(1);

      expect(result).toEqual(expected);
    });

    it('should throw when id is 0', async () => {
      await expect(productService.getStock(0)).rejects.toThrow(
        'Invalid product ID.'
      );
    });

    it('should throw when id is negative', async () => {
      await expect(productService.getStock(-5)).rejects.toThrow(
        'Invalid product ID.'
      );
    });

    it('should propagate repo error', async () => {
      mockRepository.getStock.mockRejectedValue(new Error('Database error'));
      await expect(productService.getStock(1)).rejects.toThrow(
        'Database error'
      );
    });
  });

  // =======================================================
  // POST STOCK RESERVE
  // =======================================================
  describe('postStockReserve', () => {
    it('should reserve stock and return reservation data', async () => {
      mockRepository.reserveStock.mockResolvedValue({
        id: 1,
        product: 'Ball',
        reservationToken: 'token-uuid',
      });

      const result = await productService.postStockReserve(1);

      expect(result.reservationToken).toBeDefined();
      expect(mockRepository.reserveStock).toHaveBeenCalledWith(
        1,
        expect.any(String)
      );
    });

    it('should throw when id is invalid', async () => {
      await expect(productService.postStockReserve(0)).rejects.toThrow(
        'Invalid product ID.'
      );
    });

    it('should propagate repo error when product not found', async () => {
      mockRepository.reserveStock.mockRejectedValue(
        new customError(404, 'Product not found in stock.')
      );
      await expect(productService.postStockReserve(1)).rejects.toThrow(
        'Product not found in stock.'
      );
    });

    it('should propagate repo error when stock is insufficient', async () => {
      mockRepository.reserveStock.mockRejectedValue(
        new customError(400, 'Insufficient stock quantity.')
      );
      await expect(productService.postStockReserve(1)).rejects.toThrow(
        'Insufficient stock quantity.'
      );
    });

    it('should propagate generic repo errors', async () => {
      mockRepository.reserveStock.mockRejectedValue(
        new Error('Database error')
      );
      await expect(productService.postStockReserve(1)).rejects.toThrow(
        'Database error'
      );
    });
  });

  // =======================================================
  // POST STOCK (return to stock)
  // =======================================================
  describe('postStock', () => {
    it('should return reserved item to stock', async () => {
      mockRepository.returnStock.mockResolvedValue(undefined);

      await productService.postStock(1, VALID_TOKEN);

      expect(mockRepository.returnStock).toHaveBeenCalledWith(1, VALID_TOKEN);
    });

    it('should throw when id is invalid', async () => {
      await expect(productService.postStock(0, VALID_TOKEN)).rejects.toThrow(
        'Invalid product ID.'
      );
    });

    it('should throw when token is empty string', async () => {
      await expect(productService.postStock(1, '')).rejects.toThrow(
        'Reservation token is required and must be a string.'
      );
    });

    it('should throw when token is whitespace only', async () => {
      await expect(productService.postStock(1, '   ')).rejects.toThrow(
        'Reservation token is required and must be a string.'
      );
    });

    it('should throw when token is not a string', async () => {
      await expect(productService.postStock(1, 123 as any)).rejects.toThrow(
        'Reservation token is required and must be a string.'
      );
    });

    it('should throw when token is not a valid UUID v4', async () => {
      await expect(productService.postStock(1, 'not-a-uuid')).rejects.toThrow(
        'Reservation token must be a valid UUID v4.'
      );
    });

    it('should propagate repo error when reservation not found', async () => {
      mockRepository.returnStock.mockRejectedValue(
        new customError(404, 'Reservation not found.')
      );
      await expect(productService.postStock(1, VALID_TOKEN)).rejects.toThrow(
        'Reservation not found.'
      );
    });

    it('should propagate repo error when stock not found', async () => {
      mockRepository.returnStock.mockRejectedValue(
        new customError(404, 'Product not found in stock.')
      );
      await expect(productService.postStock(1, VALID_TOKEN)).rejects.toThrow(
        'Product not found in stock.'
      );
    });
  });

  // =======================================================
  // POST STOCK SOLD
  // =======================================================
  describe('postStockSold', () => {
    it('should mark product as sold', async () => {
      mockRepository.sellStock.mockResolvedValue(undefined);

      await productService.postStockSold(1, VALID_TOKEN);

      expect(mockRepository.sellStock).toHaveBeenCalledWith(1, VALID_TOKEN);
    });

    it('should throw when id is invalid', async () => {
      await expect(
        productService.postStockSold(0, VALID_TOKEN)
      ).rejects.toThrow('Invalid product ID.');
    });

    it('should throw when token is empty string', async () => {
      await expect(productService.postStockSold(1, '')).rejects.toThrow(
        'Reservation token is required and must be a string.'
      );
    });

    it('should throw when token is not a string', async () => {
      await expect(productService.postStockSold(1, 123 as any)).rejects.toThrow(
        'Reservation token is required and must be a string.'
      );
    });

    it('should throw when token is not a valid UUID v4', async () => {
      await expect(
        productService.postStockSold(1, 'not-a-uuid')
      ).rejects.toThrow('Reservation token must be a valid UUID v4.');
    });

    it('should propagate repo error when reservation not found', async () => {
      mockRepository.sellStock.mockRejectedValue(
        new customError(404, 'Reservation not found.')
      );
      await expect(
        productService.postStockSold(1, VALID_TOKEN)
      ).rejects.toThrow('Reservation not found.');
    });

    it('should propagate generic repo errors', async () => {
      mockRepository.sellStock.mockRejectedValue(new Error('Database error'));
      await expect(
        productService.postStockSold(1, VALID_TOKEN)
      ).rejects.toThrow('Database error');
    });
  });

  // =======================================================
  // DELETE PRODUCT
  // =======================================================
  describe('deleteProduct', () => {
    it('should delete product successfully', async () => {
      mockRepository.deleteStock.mockResolvedValue(undefined);

      await productService.deleteProduct(1);

      expect(mockRepository.deleteStock).toHaveBeenCalledWith(1);
    });

    it('should throw when id is 0', async () => {
      await expect(productService.deleteProduct(0)).rejects.toThrow(
        'Invalid product ID.'
      );
    });

    it('should throw when id is negative', async () => {
      await expect(productService.deleteProduct(-1)).rejects.toThrow(
        'Invalid product ID.'
      );
    });

    it('should propagate 404 when product not found', async () => {
      mockRepository.deleteStock.mockRejectedValue(
        new customError(404, 'Product not found.')
      );
      await expect(productService.deleteProduct(1)).rejects.toThrow(
        'Product not found.'
      );
    });

    it('should propagate 409 when active reservations exist', async () => {
      mockRepository.deleteStock.mockRejectedValue(
        new customError(409, 'Cannot delete product with active reservations.')
      );
      await expect(productService.deleteProduct(1)).rejects.toThrow(
        'Cannot delete product with active reservations.'
      );
    });

    it('should propagate 409 when sales history exists', async () => {
      mockRepository.deleteStock.mockRejectedValue(
        new customError(409, 'Cannot delete product with sales history.')
      );
      await expect(productService.deleteProduct(1)).rejects.toThrow(
        'Cannot delete product with sales history.'
      );
    });

    it('should propagate generic repo errors', async () => {
      mockRepository.deleteStock.mockRejectedValue(new Error('Database error'));
      await expect(productService.deleteProduct(1)).rejects.toThrow(
        'Database error'
      );
    });
  });

  // =======================================================
  // RELEASE EXPIRED RESERVATIONS
  // =======================================================
  describe('releaseExpiredReservations', () => {
    it('should delegate to the repository and return the released count', async () => {
      mockRepository.releaseExpiredReservations.mockResolvedValue(3);
      await expect(productService.releaseExpiredReservations()).resolves.toBe(
        3
      );
      expect(mockRepository.releaseExpiredReservations).toHaveBeenCalled();
    });

    it('should propagate repo errors', async () => {
      mockRepository.releaseExpiredReservations.mockRejectedValue(
        new Error('Database error')
      );
      await expect(productService.releaseExpiredReservations()).rejects.toThrow(
        'Database error'
      );
    });
  });
});
