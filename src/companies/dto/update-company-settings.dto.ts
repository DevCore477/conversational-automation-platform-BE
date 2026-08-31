import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const companySettingsFeaturesSchema = z.object({
  inboundCalls: z.boolean().optional(),
  outboundCalls: z.boolean().optional(),
  voiceAgent: z.boolean().optional(),
  callRecording: z.boolean().optional(),
  callAnalytics: z.boolean().optional(),
  apiAccess: z.boolean().optional(),
});

const companySettingsNotificationsSchema = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  webhook: z.boolean().optional(),
});

const companySettingsIntegrationsSchema = z.object({
  twilioAccountSid: z.string().optional(),
  twilioAuthToken: z.string().optional(),
  elevenlabsApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
});

const vetClinicSchema = z.object({
  doctorNames: z.string().optional(),
  alternateWeekendSlots: z.string().optional(),
});

export const UpdateCompanySettingsSchema = z.object({
  timezone: z.string().optional(),
  dateFormat: z.string().optional(),
  currency: z.string().optional(),
  language: z.string().optional(),
  maxUsers: z.number().optional(),
  maxCallsPerMonth: z.number().optional(),
  features: companySettingsFeaturesSchema.optional(),
  notifications: companySettingsNotificationsSchema.optional(),
  integrations: companySettingsIntegrationsSchema.optional(),
  inboundPhoneNumbers: z.array(z.string()).optional(),
  vetClinic: vetClinicSchema.optional(),
});

export class UpdateCompanySettingsDto extends createZodDto(UpdateCompanySettingsSchema) {}
