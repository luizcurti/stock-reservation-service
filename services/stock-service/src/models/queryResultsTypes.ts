/**
 * @tsoaModel
 */

import { RowDataPacket } from 'mysql2';

export interface SelectProduct extends RowDataPacket {
  id: number;
  stock: number;
  reserve: number;
  sold: number;
}

export interface searchStock extends RowDataPacket {
  id: number;
  product: string;
  qtd: number;
}

export interface searchStockReserve extends RowDataPacket {
  id_stock: number;
  product: string;
  reservationToken: string;
}

export interface searchStockSold extends RowDataPacket {
  id_stock: number;
  product: string;
  reservationToken: string;
}
