import { registerAs } from '@nestjs/config';

/**
 * Vet clinic config. Used when a company's inbound script name matches vetScriptName.
 *
 * Inbound routing (multiple vet clinics in Norway):
 * - Script is resolved by CALLED number (To): match company.phone or company.settings.inboundPhoneNumbers
 * - Each clinic (company) has its own script in DB; language from called number's country code (+47=no, +44=en)
 * - Per-clinic vet config: set company.settings.vetClinic = { doctorNames, alternateWeekendSlots }
 * - company.phone is used ONLY for inbound number matching (nothing else)
 * - Global fallback below when company.settings.vetClinic is not set
 */
export default registerAs('vetClinic', () => ({
  /** Vet script name in DB. When a company's script matches this, vet template is used with doctorNames/slots. */
  vetScriptName: process.env.VET_SCRIPT_NAME || 'Vet Clinic NO',
  /** Global fallback: comma-separated doctor names (overridden by company.settings.vetClinic.doctorNames). */
  doctorNames: process.env.VET_DOCTOR_NAMES || 'Dr. Hansen, Dr. Olsen, Dr. Nilsen',
  /** Global fallback: alternate weekend slots (overridden by company.settings.vetClinic.alternateWeekendSlots). */
  alternateWeekendSlots:
    process.env.VET_ALTERNATE_WEEKEND_SLOTS ||
    'Lørdag 8. mars 10:00, Lørdag 8. mars 14:00, Søndag 9. mars 10:00, Søndag 9. mars 14:00',
}));
