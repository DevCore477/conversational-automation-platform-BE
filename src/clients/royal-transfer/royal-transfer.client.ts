import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

import { parsePobBooking, RoyalTransferPobBooking } from './royal-transfer.types';

const REQUEST_TIMEOUT_MS = 15_000;

export class RoyalTransferClient {
  private readonly logger = new Logger(RoyalTransferClient.name);
  private readonly client: AxiosInstance;
  private readonly useBearerAuth: boolean;

  constructor(baseUrl: string, apiSecret: string, options?: { useBearerAuth?: boolean }) {
    this.useBearerAuth = options?.useBearerAuth ?? false;

    this.client = axios.create({
      baseURL: baseUrl.replace(/\/$/, ''),
      timeout: REQUEST_TIMEOUT_MS,
      headers: this.buildAuthHeaders(apiSecret),
      validateStatus: () => true,
    });

    this.logger.log(
      `Royal Transfer client initialized; baseUrl=${baseUrl}; auth=${this.useBearerAuth ? 'Bearer' : 'x-api-secret'}`,
    );
  }

  private log401(): void {
    this.logger.warn(
      'Royal Transfer API returned 401 Unauthorized — invalid or missing microservice secret',
    );
  }

  private logServerError(
    status: number,
    statusText: string,
    url: string,
    context = 'request failed',
  ): void {
    this.logger.warn(`Royal Transfer API error: ${status} ${statusText} — ${url}; ${context}`);
  }

  private logNetworkError(url: string, context: string, code?: string): void {
    this.logger.warn(`Royal Transfer API unreachable (${code ?? 'error'}) — ${url}; ${context}`);
  }

  private logRequestFailed(url: string, context: string, message: string): void {
    this.logger.warn(`Royal Transfer API request failed: ${message} — ${url}; ${context}`);
  }

  private handleAxiosError(error: unknown, url: string, context: string): void {
    if (axios.isAxiosError(error)) {
      const err = error as AxiosError;
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        this.logger.warn(`Royal Transfer API request timeout — ${url}; ${context}`);
        return;
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        this.logNetworkError(url, context, err.code);
        return;
      }
      if (err.response?.status === 401) {
        this.log401();
        return;
      }
      if (err.response && err.response.status >= 500) {
        this.logger.warn(`Royal Transfer API ${err.response.status} — ${url}; ${context}`);
        return;
      }
      this.logRequestFailed(url, context, err.message ?? 'unknown');
      return;
    }
    this.logger.warn(
      `Royal Transfer API unexpected error: ${(error as Error).message}; ${context}`,
    );
  }

  private buildAuthHeaders(apiSecret: string): Record<string, string> {
    if (this.useBearerAuth) {
      return {
        Authorization: `Bearer ${apiSecret}`,
        'Content-Type': 'application/json',
      };
    }
    return {
      'x-api-secret': apiSecret,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Fetches today's POB bookings from Royal Transfer API.
   *
   * Request: GET /public/bookings with header x-api-secret (or Authorization: Bearer).
   * Response: 200 OK, JSON array of booking objects (bookingId, rt, pickup, dropOff,
   * status, time, date, driverName, driverNumber).
   *
   * Semantics (handled by the API; no client-side filtering needed):
   * - Only today's bookings (server date = today).
   * - Only bookings whose scheduled time has not passed (e.g. at 15:00, 14:00 excluded, 16:00 included).
   * - Bookings with no time are excluded.
   * Use this list for reminder logic; no need to filter by date/time again.
   *
   * On 401: treats as invalid/missing secret, logs and returns empty array.
   * On 5xx/timeouts: logs and rethrows so callers can monitor.
   */
  async getTodayPobBookings(): Promise<RoyalTransferPobBooking[]> {
    const url = '/public/bookings';

    try {
      const res = await this.client.get<unknown>(url);

      if (res.status === 401) {
        this.log401();
        return [];
      }
      if (res.status >= 500) {
        this.logServerError(res.status, res.statusText, url, 'returning empty bookings');
        return [];
      }
      if (res.status !== 200) {
        this.logger.warn(`Royal Transfer API unexpected status: ${res.status} — ${url}`);
        return [];
      }

      const data = res.data;
      if (!Array.isArray(data)) {
        this.logger.warn('Royal Transfer API response is not a JSON array; returning empty list');
        return [];
      }

      return data.map((item: unknown) =>
        parsePobBooking(
          typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {},
        ),
      );
    } catch (error) {
      this.handleAxiosError(error, url, 'returning empty bookings');
      return [];
    }
  }

  /**
   * Marks a booking's information call as sent (or not) on Royal Transfer.
   * Call this after your microservice has sent the information call to the driver.
   * PATCH /public/bookings/:id/information-call-sent with body { informationCallSent: boolean }.
   * On success (200), the booking is excluded from future GET /public/bookings.
   */
  async updateInformationCallSent(bookingId: string, informationCallSent: boolean): Promise<void> {
    const url = `/public/bookings/${encodeURIComponent(bookingId)}/information-call-sent`;

    try {
      const res = await this.client.patch<unknown>(url, {
        informationCallSent,
      });

      if (res.status === 401) {
        this.log401();
        return;
      }
      if (res.status === 404) {
        this.logger.warn(
          `Royal Transfer API: booking ${bookingId} not found for information-call-sent update`,
        );
        return;
      }
      if (res.status >= 400 && res.status < 500) {
        this.logger.warn(`Royal Transfer API ${res.status} for information-call-sent — ${url}`);
        return;
      }
      if (res.status >= 500) {
        this.logServerError(res.status, res.statusText, url);
        return;
      }

      this.logger.log(
        `Marked information call sent for booking ${bookingId}: ${informationCallSent}`,
      );
    } catch (error) {
      this.handleAxiosError(error, url, 'skipping mark information call sent');
    }
  }

  /**
   * Records driver call response after each information or confirmation call.
   * POST /public/bookings/:id/driver-call-response
   */
  async postDriverCallResponse(
    bookingId: string,
    payload: {
      callType: 'information' | 'confirmation';
      confirmed: boolean;
      reason?: string | null;
      callResult: 'answered' | 'missed' | 'busy' | 'failed';
    },
  ): Promise<boolean> {
    const url = `/public/bookings/${encodeURIComponent(bookingId)}/driver-call-response`;

    try {
      const res = await this.client.post<unknown>(url, payload);

      if (res.status === 401) {
        this.logger.warn(
          'Royal Transfer API returned 401 — invalid or missing microservice secret',
        );
        return false;
      }

      if (res.status === 404) {
        this.logger.warn(
          `Royal Transfer API: booking ${bookingId} not found for driver-call-response (or no driver)`,
        );
        return false;
      }

      if (res.status >= 400 && res.status < 500) {
        this.logger.warn(`Royal Transfer API ${res.status} for driver-call-response — ${url}`);
        return false;
      }

      if (res.status >= 500) {
        this.logServerError(res.status, res.statusText, url);
        return false;
      }
      if (res.status === 201) {
        this.logger.log(
          `Recorded driver call response for booking ${bookingId}: ${payload.callType} ${payload.callResult} confirmed=${payload.confirmed}`,
        );
        return true;
      }

      return false;
    } catch (error) {
      this.handleAxiosError(error, url, 'skipping driver-call-response');
      return false;
    }
  }

  /**
   * Cancels a booking by driver (from call). Sets booking status to CANCELLED.
   * PATCH /public/bookings/:id/cancel-by-driver
   */
  async cancelBookingByDriver(bookingId: string, reason?: string | null): Promise<boolean> {
    const url = `/public/bookings/${encodeURIComponent(bookingId)}/cancel-by-driver`;

    try {
      const res = await this.client.patch<unknown>(
        url,
        reason != null && reason !== '' ? { reason } : {},
      );

      if (res.status === 401) {
        this.log401();
        return false;
      }
      if (res.status === 404) {
        this.logger.warn(`Royal Transfer API: booking ${bookingId} not found for cancel-by-driver`);
        return false;
      }
      if (res.status >= 400 && res.status < 500) {
        this.logger.warn(`Royal Transfer API ${res.status} for cancel-by-driver — ${url}`);
        return false;
      }
      if (res.status >= 500) {
        this.logServerError(res.status, res.statusText, url);
        return false;
      }

      if (res.status === 200) {
        this.logger.log(`Booking ${bookingId} cancelled by driver${reason ? `: ${reason}` : ''}`);
        return true;
      }

      return false;
    } catch (error) {
      this.handleAxiosError(error, url, 'skipping cancel-by-driver');
      return false;
    }
  }
}
