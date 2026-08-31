import { registerAs } from '@nestjs/config';

/** Default script for POB (and non-cancelled) driver reminder: ask driver to confirm they are coming. */
const DEFAULT_DRIVER_REMINDER_TEMPLATE = `Hi {{driverName}}, this is a quick reminder about your booking. Can you confirm that you are coming for the pickup and drop-off? You have a transfer from {{pickup}} to {{dropOff}} at {{time}} on {{date}}. Please confirm if you will be there.`;

/** Default script when booking status is CANCELLED: inform driver only. */
const DEFAULT_DRIVER_REMINDER_TEMPLATE_CANCELLED = `Hi {{driverName}}, we are informing you that your booking has been cancelled. The cancelled booking was a transfer from {{pickup}} to {{dropOff}} scheduled for {{time}} on {{date}}. Thank you.`;

/** Default: every 2 hours (at 0 min past hour 0, 2, 4, ...). Standard 5-field cron. */
const DEFAULT_DRIVER_REMINDER_CRON = '0 */2 * * *';

export default registerAs('royalTransfer', () => ({
  baseUrl: process.env.ROYAL_TRANSFER_BASE_URL ?? '',
  apiSecret: process.env.ROYAL_TRANSFER_API_SECRET ?? process.env.MICROSERVICE_SECRET ?? '',
  /** Template for POB (and non-cancelled) driver reminder. Placeholders: {{driverName}}, {{pickup}}, {{dropOff}}, {{time}}, {{date}}, {{status}} */
  driverReminderScriptTemplate:
    process.env.DRIVER_REMINDER_SCRIPT_TEMPLATE ?? DEFAULT_DRIVER_REMINDER_TEMPLATE,
  /** Template when status is CANCELLED. Same placeholders. */
  driverReminderScriptTemplateCancelled:
    process.env.DRIVER_REMINDER_SCRIPT_TEMPLATE_CANCELLED ??
    DEFAULT_DRIVER_REMINDER_TEMPLATE_CANCELLED,
  /** Enable cron job that triggers driver reminders (default: true). Set to "false" to disable. */
  driverReminderCronEnabled: process.env.DRIVER_REMINDER_CRON_ENABLED !== 'false',
  /** Cron expression for driver reminders (default: every 2 hours). */
  driverReminderCronExpression:
    process.env.DRIVER_REMINDER_CRON_EXPRESSION ?? DEFAULT_DRIVER_REMINDER_CRON,
}));
