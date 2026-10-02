import { ProductService } from '../services/ProductService';
import { reservationsReleased } from './metrics';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically returns expired reservations to stock. Runs once immediately
 * (so a restarted process doesn't wait a full interval to catch up) and then
 * on a timer. Safe to run in multiple replicas: each expired reservation is
 * released through returnStock's FOR UPDATE transaction, so only one replica
 * wins per row and the rest just see "not found" and move on.
 */
export function startReservationExpiryScheduler(
  productService: ProductService = new ProductService(),
  intervalMs: number = parseInt(
    process.env.RESERVATION_CLEANUP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
    10
  )
): NodeJS.Timeout {
  const run = async (): Promise<void> => {
    try {
      const released = await productService.releaseExpiredReservations();
      if (released > 0) {
        reservationsReleased.inc(released);
        console.log(
          `[reservation-expiry] released ${released} expired reservation(s) back to stock`
        );
      }
    } catch (error) {
      console.error(
        '[reservation-expiry] failed to release expired reservations',
        error
      );
    }
  };

  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return timer;
}
