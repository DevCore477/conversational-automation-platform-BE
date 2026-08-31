import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RefreshTokenBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export class RefreshTokenBodyDto extends createZodDto(RefreshTokenBodySchema) {}
