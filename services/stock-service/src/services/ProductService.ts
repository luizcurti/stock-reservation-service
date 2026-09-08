import { ProductRepository } from '../repositories/ProductRepository';
import { v4 as uuidv4 } from 'uuid';
import { customError } from '../customErrors/customErrors';
import {
  responseGetStock,
  responseInsertStockReserve,
  responsePathStock,
  StockUpdateRequest,
} from '../models/responseTypes';

export class ProductService {
  constructor(private rep: ProductRepository = new ProductRepository()) {}

  public async patchStock(
    id: number,
    body: StockUpdateRequest
  ): Promise<responsePathStock> {
    this.validatePositiveId(id);
    const { product, qtd } = this.validateStockData(body);

    const existing = await this.rep.searchStock(id);
    if (existing === null) {
      return await this.rep.insertStock(id, product, qtd);
    } else {
      return await this.rep.updateStock(id, product, qtd);
    }
  }

  public async getStock(id: number): Promise<responseGetStock> {
    this.validatePositiveId(id);
    return await this.rep.getStock(id);
  }

  public async postStockReserve(
    id: number
  ): Promise<responseInsertStockReserve> {
    this.validatePositiveId(id);
    const uuid = uuidv4();
    return await this.rep.reserveStock(id, uuid);
  }

  public async postStock(id: number, reservationToken: string): Promise<void> {
    this.validatePositiveId(id);
    this.validateToken(reservationToken);
    return await this.rep.returnStock(id, reservationToken);
  }

  public async postStockSold(
    id: number,
    reservationToken: string
  ): Promise<void> {
    this.validatePositiveId(id);
    this.validateToken(reservationToken);
    return await this.rep.sellStock(id, reservationToken);
  }

  public async deleteProduct(id: number): Promise<void> {
    this.validatePositiveId(id);
    return await this.rep.deleteStock(id);
  }

  public async releaseExpiredReservations(): Promise<number> {
    return await this.rep.releaseExpiredReservations();
  }

  private validatePositiveId(id: number): void {
    if (!id || id <= 0 || !Number.isInteger(id)) {
      throw new customError(400, 'Invalid product ID.');
    }
  }

  private validateStockData(body: unknown): { product: string; qtd: number } {
    if (!body || typeof body !== 'object') {
      throw new customError(400, 'Invalid request body.');
    }

    const data = body as Record<string, unknown>;
    const { product, qtd } = data;

    if (
      !product ||
      typeof product !== 'string' ||
      (product as string).trim().length === 0
    ) {
      throw new customError(
        400,
        'Product name is required and must be a string.'
      );
    }

    if ((product as string).length > 100) {
      throw new customError(
        400,
        'Product name must be at most 100 characters.'
      );
    }

    if (qtd === undefined || qtd === null) {
      throw new customError(400, 'Quantity is required.');
    }

    const parsedQtd = typeof qtd === 'number' ? qtd : parseInt(String(qtd), 10);

    if (isNaN(parsedQtd) || parsedQtd < 0) {
      throw new customError(400, 'Quantity must be a non-negative number.');
    }

    return { product: (product as string).trim(), qtd: parsedQtd };
  }

  private validateToken(reservationToken: string): void {
    if (
      !reservationToken ||
      typeof reservationToken !== 'string' ||
      reservationToken.trim().length === 0
    ) {
      throw new customError(
        400,
        'Reservation token is required and must be a string.'
      );
    }
    const UUID_V4_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_V4_REGEX.test(reservationToken)) {
      throw new customError(400, 'Reservation token must be a valid UUID v4.');
    }
  }
}
