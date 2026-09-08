import { ProductController } from '../src/controllers/ProductController';
import { ProductService } from '../src/services/ProductService';

jest.mock('../src/services/ProductService');

const mockProductService = new ProductService() as jest.Mocked<ProductService>;

describe('ProductController', () => {
  let productController: ProductController;

  beforeEach(() => {
    jest.clearAllMocks();
    productController = new ProductController(mockProductService);
  });

  describe('constructor', () => {
    it('should create instance with provided ProductService', () => {
      const controller = new ProductController(mockProductService);
      expect(controller).toBeInstanceOf(ProductController);
    });

    it('should create instance with default ProductService when none provided', () => {
      const controller = new ProductController();
      expect(controller).toBeInstanceOf(ProductController);
    });
  });

  describe('getStock', () => {
    it('should return stock data successfully', async () => {
      const expectedResult = { ID: 1, IN_STOCK: 10, RESERVE: 2, SOLD: 5 };
      mockProductService.getStock.mockResolvedValue(expectedResult);

      const result = await productController.getStock(1);

      expect(mockProductService.getStock).toHaveBeenCalledWith(1);
      expect(result).toEqual(expectedResult);
    });

    it('should propagate service errors', async () => {
      const error = new Error('Service error');
      mockProductService.getStock.mockRejectedValue(error);

      await expect(productController.getStock(1)).rejects.toThrow(
        'Service error'
      );
    });
  });

  describe('patchStock', () => {
    it('should update/create stock successfully', async () => {
      const expectedResult = { id: 1, product: 'Ball', stock: 200 };
      mockProductService.patchStock.mockResolvedValue(expectedResult);

      const result = await productController.patchStock(1, {
        product: 'Ball',
        qtd: 200,
      });

      expect(mockProductService.patchStock).toHaveBeenCalledWith(1, {
        product: 'Ball',
        qtd: 200,
      });
      expect(result).toEqual(expectedResult);
    });

    it('should propagate service errors', async () => {
      const error = new Error('Service error');
      mockProductService.patchStock.mockRejectedValue(error);

      await expect(
        productController.patchStock(1, { product: 'Ball', qtd: 200 })
      ).rejects.toThrow('Service error');
    });
  });

  describe('postStockReserve', () => {
    it('should reserve stock successfully', async () => {
      const expectedResult = {
        id: 1,
        product: 'Ball',
        reservationToken: 'uuid-123',
      };
      mockProductService.postStockReserve.mockResolvedValue(expectedResult);

      const result = await productController.postStockReserve(1);

      expect(mockProductService.postStockReserve).toHaveBeenCalledWith(1);
      expect(result).toEqual(expectedResult);
    });

    it('should propagate service errors', async () => {
      const error = new Error('Service error');
      mockProductService.postStockReserve.mockRejectedValue(error);

      await expect(productController.postStockReserve(1)).rejects.toThrow(
        'Service error'
      );
    });
  });

  describe('postStock', () => {
    it('should return reserved product to stock successfully', async () => {
      mockProductService.postStock.mockResolvedValue();

      await productController.postStock(1, { reservationToken: 'token-abc' });

      expect(mockProductService.postStock).toHaveBeenCalledWith(1, 'token-abc');
    });

    it('should propagate service errors', async () => {
      const error = new Error('Service error');
      mockProductService.postStock.mockRejectedValue(error);

      await expect(
        productController.postStock(1, { reservationToken: 'token-abc' })
      ).rejects.toThrow('Service error');
    });
  });

  describe('postStockSold', () => {
    it('should mark stock as sold successfully', async () => {
      mockProductService.postStockSold.mockResolvedValue();

      await productController.postStockSold(1, {
        reservationToken: 'token-abc',
      });

      expect(mockProductService.postStockSold).toHaveBeenCalledWith(
        1,
        'token-abc'
      );
    });

    it('should propagate service errors', async () => {
      const error = new Error('Service error');
      mockProductService.postStockSold.mockRejectedValue(error);

      await expect(
        productController.postStockSold(1, { reservationToken: 'token-abc' })
      ).rejects.toThrow('Service error');
    });
  });

  describe('deleteProduct', () => {
    it('should delete product successfully', async () => {
      mockProductService.deleteProduct.mockResolvedValue();

      await productController.deleteProduct(1);

      expect(mockProductService.deleteProduct).toHaveBeenCalledWith(1);
    });

    it('should propagate service errors', async () => {
      const error = new Error('Service error');
      mockProductService.deleteProduct.mockRejectedValue(error);

      await expect(productController.deleteProduct(1)).rejects.toThrow(
        'Service error'
      );
    });
  });
});
