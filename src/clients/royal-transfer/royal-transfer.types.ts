/** Booking status from Royal Transfer API. */
export type RoyalTransferBookingStatus =
  | 'POB'
  | 'PASSENGER_NO_SHOW'
  | 'COMPLETED'
  | 'DISPATCHED'
  | 'CANCELLED';

/**
 * Today's POB (Pick-up on Behalf) booking from Royal Transfer API.
 * API returns only today's bookings whose scheduled time has not passed yet;
 * bookings with no time are excluded. Use this list for reminder logic; no
 * need to filter by date/time again.
 */
export interface RoyalTransferPobBooking {
  bookingId: string;
  rt: number;
  pickup: string | null;
  dropOff: string | null;
  status: RoyalTransferBookingStatus;
  time: string | null;
  date: string | null;
  driverName: string | null;
  driverNumber: string | null;
}

const VALID_STATUSES: RoyalTransferBookingStatus[] = [
  'POB',
  'PASSENGER_NO_SHOW',
  'CANCELLED',
  'COMPLETED',
  'DISPATCHED',
];

function parseStatus(raw: unknown): RoyalTransferBookingStatus {
  if (typeof raw === 'string' && VALID_STATUSES.includes(raw as RoyalTransferBookingStatus)) {
    return raw as RoyalTransferBookingStatus;
  }
  return 'POB';
}

export function parsePobBooking(raw: Record<string, unknown>): RoyalTransferPobBooking {
  return {
    bookingId: typeof raw.bookingId === 'string' ? raw.bookingId : '',
    rt: typeof raw.rt === 'number' ? raw.rt : 0,
    pickup: raw.pickup == null ? null : String(raw.pickup),
    dropOff: raw.dropOff == null ? null : String(raw.dropOff),
    status: parseStatus(raw.status),
    time: raw.time == null ? null : String(raw.time),
    date: raw.date == null ? null : String(raw.date),
    driverName: raw.driverName == null ? null : String(raw.driverName),
    driverNumber: raw.driverNumber == null ? null : String(raw.driverNumber),
  };
}
