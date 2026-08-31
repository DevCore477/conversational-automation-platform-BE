import { RoyalTransferPobBooking } from './royal-transfer.types';

/**
 * Phrase the agent MUST say when the driver has confirmed cancellation and given a reason.
 * The bridge detects this to cancel the booking on the platform and end the call.
 * Format: "[PREFIX][reason]. Goodbye."
 */
export const DRIVER_CANCELLATION_PHRASE_PREFIX = "I've recorded your cancellation. Reason: ";

/**
 * Phrase the agent MUST say when the driver has confirmed they can do the pickup.
 * The bridge detects this to end the call after a short goodbye buffer.
 */
export const DRIVER_CONFIRMATION_PHRASE = "You've confirmed you're doing the pickup. Goodbye.";

/** Placeholders supported in the driver reminder template. */
export const DRIVER_REMINDER_PLACEHOLDERS = [
  '{{driverName}}',
  '{{pickup}}',
  '{{dropOff}}',
  '{{time}}',
  '{{date}}',
  '{{status}}',
] as const;

/**
 * Formats a time string (e.g. "20:15:00") for speech.
 * Returns "8:15 PM" for 12h or "20:15" if you prefer 24h.
 */
function formatTimeForSpeech(timeStr: string | null): string {
  if (!timeStr || typeof timeStr !== 'string') return '';
  const parts = timeStr.trim().split(':');
  const h = parseInt(parts[0] ?? '0', 10);
  const m = parts[1] ?? '00';
  if (h === 0) return `12:${m} AM`;
  if (h === 12) return `12:${m} PM`;
  if (h < 12) return `${h}:${m} AM`;
  return `${h - 12}:${m} PM`;
}

/**
 * Formats a date string (YYYY-MM-DD) for speech (e.g. "January 28, 2026").
 */
function formatDateForSpeech(dateStr: string | null): string {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, mo, d] = dateStr.trim().split('-');
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const month = monthNames[parseInt(mo ?? '1', 10) - 1] ?? '';
  return `${month} ${parseInt(d ?? '0', 10)}, ${y ?? ''}`;
}

/**
 * Renders the driver reminder script for a booking by replacing template placeholders.
 * Placeholders: {{driverName}}, {{pickup}}, {{dropOff}}, {{time}}, {{date}}, {{status}}
 */
export function renderDriverReminderScript(
  booking: RoyalTransferPobBooking,
  template: string,
): string {
  const driverName = booking.driverName ?? 'Driver';
  const pickup = booking.pickup ?? '';
  const dropOff = booking.dropOff ?? '';
  const time = formatTimeForSpeech(booking.time);
  const date = formatDateForSpeech(booking.date);
  const status = booking.status ?? 'POB';

  return template
    .replace(/\{\{driverName\}\}/g, driverName)
    .replace(/\{\{pickup\}\}/g, pickup)
    .replace(/\{\{dropOff\}\}/g, dropOff)
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{status\}\}/g, status);
}

/**
 * Builds the agent system prompt for an interactive driver reminder call.
 * The agent will deliver the reminder, answer follow-up questions, and allow the driver to cancel the booking (with reason) as part of confirmation.
 */
export function buildInteractiveReminderAgentScript(
  booking: RoyalTransferPobBooking,
  renderedReminder: string,
): string {
  const driverName = booking.driverName ?? 'Driver';
  const pickup = booking.pickup ?? '—';
  const dropOff = booking.dropOff ?? '—';
  const time = formatTimeForSpeech(booking.time) || '—';
  const date = formatDateForSpeech(booking.date) || '—';
  const status = booking.status ?? 'POB';

  return `You are a warm, polite phone assistant for Royal Transfer. You are on a call with a driver to give them a booking reminder and confirm whether they can do the pickup. Always be courteous, use please and thank you, and never sound rude or dismissive. You only speak and respond in English; if the driver speaks in Urdu or any other language, politely ask them to please speak in English. If you hear unclear speech or background noise, ask them to repeat in English.

BOOKING DETAILS (use these to answer any question):
- Driver name: ${driverName}
- Pickup address: ${pickup}
- Drop-off address: ${dropOff}
- Time: ${time}
- Date: ${date}
- Status: ${status}

Your first message will already say this reminder: "${renderedReminder}"

CANCELLATION (takes priority over confirmation — if the user indicates they cannot come or want to cancel, treat as cancellation only):
- If the driver says they cannot do the pickup, cannot make it, want to cancel, need to cancel, or gives a reason they can't come (e.g. "my car broke", "I can't come", "I'm sick", "I need to cancel"): treat this as CANCELLATION only. Do NOT treat "yes" or "ok" in that context as confirmation of the pickup. "Yes" after a cancellation reason means "yes that's the reason" or "yes I'm cancelling" — never treat it as "yes I'll do the pickup".
- When the driver indicates they want to cancel or can't come, ask politely for the reason if you don't have it yet (e.g. "No problem at all. Could you tell me why you need to cancel?" or "Thank you for letting us know. What's the reason you can't make this pickup?"). Accept reasons like: car broke, unavailable, wrong number, sick, other commitment, etc.
- When the driver has given the reason (e.g. "my car broke and I can't come"), thank them and say exactly this sentence (replace [reason] with the reason they gave): "Thank you. I've recorded your cancellation. Reason: [reason]. Goodbye." Say nothing else after that. Do not add extra words. Never say "You've confirmed you're doing the pickup" when the user said they can't come or want to cancel.
- Once the user has said they want to cancel or can't come, the rest of the call is cancellation flow only. Do not switch to confirmation.

WHEN THE DRIVER CONFIRMS THEY CAN DO THE PICKUP (only when they have NOT said they want to cancel or can't come):
- Only say "Thank you. You've confirmed you're doing the pickup. Goodbye." when the driver has CLEARLY said they WILL do the pickup (e.g. "yes I'll be there", "yes I can do it", "I'll be there"). They must NOT have said they want to cancel, can't come, car broke, sick, or any reason they can't make it.
- If the user ever said they can't come, need to cancel, car broke, or similar, do NOT say the confirmation phrase. Say the cancellation phrase instead with their reason.
- Do not add extra words before or after this sentence when ending after confirmation.

OTHER RESPONSES:
- When they ask a question about the booking (e.g. "What was the address?", "Can you repeat the time?", "Where is pickup?"), answer right away in a friendly way using the booking details above. Give a clear, helpful answer once. Never stay silent after the user speaks.
- If the user asks the same question again (e.g. because of delay or they didn't hear), do not give the full answer again. Answer only once: say briefly e.g. "As I said, [one line]. Anything else?" or "That's [brief answer]. Can I help with something else?"
- When they have no more questions and are not cancelling and have not yet confirmed, say a warm goodbye (e.g. "Thank you for your time. Goodbye!").`;
}
