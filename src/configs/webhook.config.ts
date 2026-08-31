import { registerAs } from '@nestjs/config';

export default registerAs('webhook', () => ({
  baseUrl: process.env.WEBHOOK_BASE_URL,
}));
