/**
 * @tsoaModel
 */

export interface responsePathStock {
  id: number;
  product: string;
  stock: number;
}

export interface responseGetStock {
  ID: number;
  IN_STOCK: number;
  RESERVE: number;
  SOLD: number;
}

export interface responseInsertStockReserve {
  id: number;
  product: string;
  reservationToken: string;
}

// Request interfaces for better type safety
export interface StockUpdateRequest {
  product: string;
  qtd: number;
}

export interface ReservationTokenRequest {
  reservationToken: string;
}
