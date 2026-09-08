-- Stock Management System Database Schema
-- Version: 2.0
-- Date: 2024

-- Create database if it doesn't exist
CREATE DATABASE IF NOT EXISTS stock
  DEFAULT CHARACTER SET utf8mb4 
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE stock;

-- Drop tables if they exist (for development purposes)
DROP TABLE IF EXISTS SOLD;
DROP TABLE IF EXISTS RESERVED;
DROP TABLE IF EXISTS IN_STOCK;

-- Create IN_STOCK table
CREATE TABLE `IN_STOCK` (
  `id` int NOT NULL PRIMARY KEY,
  `product` varchar(100) NOT NULL,
  `qtd` int NOT NULL DEFAULT 0,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_product` (`product`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create RESERVED table
-- expires_at's own default (24h) is only a fallback for a row inserted
-- outside the app; ProductRepository.reserveStock always sets it explicitly
-- from RESERVATION_TTL_MINUTES (default 30 min — see the stock-service
-- README's "Reservation expiry" section).
CREATE TABLE `RESERVED` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `id_stock` int NOT NULL,
  `product` varchar(100) NOT NULL,
  `reservationToken` varchar(100) NOT NULL UNIQUE,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `expires_at` timestamp DEFAULT (DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)),
  INDEX `idx_id_stock` (`id_stock`),
  INDEX `idx_reservation_token` (`reservationToken`),
  INDEX `idx_expires_at` (`expires_at`),
  FOREIGN KEY (`id_stock`) REFERENCES `IN_STOCK`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create SOLD table
CREATE TABLE `SOLD` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `id_stock` int NOT NULL,
  `product` varchar(100) NOT NULL,
  `reservationToken` varchar(100) NOT NULL,
  `sold_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_sold_reservation_token` (`reservationToken`),
  INDEX `idx_id_stock` (`id_stock`),
  INDEX `idx_reservation_token` (`reservationToken`),
  INDEX `idx_sold_at` (`sold_at`),
  FOREIGN KEY (`id_stock`) REFERENCES `IN_STOCK`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert some sample data for testing (optional)
INSERT INTO `IN_STOCK` (`id`, `product`, `qtd`) VALUES
(1, 'Soccer Ball', 50),
(2, 'Basketball', 30),
(3, 'Tennis Ball', 100),
(4, 'Baseball', 25),
(5, 'Volleyball', 15);

-- Create a view for stock summary
CREATE OR REPLACE VIEW stock_summary AS
SELECT 
    s.id,
    s.product,
    s.qtd as available_stock,
    COALESCE(r.reserved_count, 0) as reserved_count,
    COALESCE(sold.sold_count, 0) as sold_count,
    (s.qtd + COALESCE(r.reserved_count, 0) + COALESCE(sold.sold_count, 0)) as total_initial_stock
FROM IN_STOCK s
LEFT JOIN (
    SELECT id_stock, COUNT(*) as reserved_count 
    FROM RESERVED 
    WHERE expires_at > NOW()
    GROUP BY id_stock
) r ON s.id = r.id_stock
LEFT JOIN (
    SELECT id_stock, COUNT(*) as sold_count 
    FROM SOLD 
    GROUP BY id_stock
) sold ON s.id = sold.id_stock;

-- Expired reservations are released back to stock by the application
-- (src/config/reservationExpiryScheduler.ts), not by MySQL: SET GLOBAL
-- event_scheduler requires a privilege app_user won't have on most managed
-- MySQL instances, and a GLOBAL setting doesn't survive a server restart
-- unless persisted in the server config — either of which would leave
-- reservations silently piling up forever with no indication anything was
-- wrong. Releasing them from the app keeps the behavior testable and
-- consistent across environments.

