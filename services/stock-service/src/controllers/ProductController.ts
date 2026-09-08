import {
  Body,
  Controller,
  Delete,
  Get,
  Path,
  Post,
  Patch,
  Route,
  SuccessResponse,
} from '@tsoa/runtime';

import { ProductService } from '../services/ProductService';
import {
  responseGetStock,
  responseInsertStockReserve,
  responsePathStock,
  StockUpdateRequest,
  ReservationTokenRequest,
} from '../models/responseTypes';

@Route('/product')
export class ProductController extends Controller {
  constructor(private productService: ProductService = new ProductService()) {
    super();
  }

  /**
   * Update or create stock for a product
   */
  @Patch('/{id}/stock')
  public async patchStock(
    @Path() id: number,
    @Body() body: StockUpdateRequest
  ): Promise<responsePathStock> {
    return await this.productService.patchStock(id, body);
  }

  /**
   * Get stock information for a product
   */
  @Get('/{id}/')
  public async getStock(@Path() id: number): Promise<responseGetStock> {
    return await this.productService.getStock(id);
  }

  /**
   * Reserve a product from stock
   */
  @SuccessResponse(201, 'Created')
  @Post('/{id}/reserve')
  public async postStockReserve(
    @Path() id: number
  ): Promise<responseInsertStockReserve> {
    this.setStatus(201);
    return await this.productService.postStockReserve(id);
  }

  /**
   * Return a reserved product to stock
   */
  @Post('/{id}/return')
  public async postStock(
    @Path() id: number,
    @Body() body: ReservationTokenRequest
  ): Promise<void> {
    return await this.productService.postStock(id, body.reservationToken);
  }

  /**
   * Mark a reserved product as sold
   */
  @Post('/{id}/sold')
  public async postStockSold(
    @Path() id: number,
    @Body() body: ReservationTokenRequest
  ): Promise<void> {
    return await this.productService.postStockSold(id, body.reservationToken);
  }

  /**
   * Delete a product from stock (only if no active reservations or sales history)
   */
  @Delete('/{id}')
  @SuccessResponse(204, 'No Content')
  public async deleteProduct(@Path() id: number): Promise<void> {
    return await this.productService.deleteProduct(id);
  }
}
