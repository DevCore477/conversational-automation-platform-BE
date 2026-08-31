import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CompanySizeEnum,
  UseCaseEnum,
  ImplementationEnum,
  AgentsCountEnum,
} from '../../models/connect-us/connect-us.entity';

export const CreateConnectUsSchema = z.object({
  firstName: z
    .string()
    .min(1, 'First name is required')
    .max(100, 'First name must be less than 100 characters'),
  lastName: z
    .string()
    .min(1, 'Last name is required')
    .max(100, 'Last name must be less than 100 characters'),
  email: z.string().email('Invalid email address'),
  companySize: z.enum(CompanySizeEnum).optional(),
  useCase: z.enum(UseCaseEnum).optional(),
  implementation: z.enum(ImplementationEnum).optional(),
  agentsCount: z.enum(AgentsCountEnum).optional(),
  message: z.string().optional(),
  referralSource: z.string().optional(),
});

export class CreateConnectUsDto extends createZodDto(CreateConnectUsSchema) {}
