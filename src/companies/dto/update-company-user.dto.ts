import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CompanyUserStatus } from '../../common/enums';
import { CompanyRoles } from './add-user-to-company.dto';

export const UpdateCompanyUserSchema = z
  .object({
    companyRole: z
      .enum(CompanyRoles)
      .optional()
      .describe('Role within the company (omit to leave unchanged)'),
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    companyStatus: z
      .enum([CompanyUserStatus.PENDING, CompanyUserStatus.ACTIVE, CompanyUserStatus.INACTIVE])
      .optional(),
  })
  .refine(
    d =>
      d.companyRole !== undefined ||
      d.firstName !== undefined ||
      d.lastName !== undefined ||
      d.companyStatus !== undefined,
    { message: 'Provide at least one of: companyRole, firstName, lastName, companyStatus' },
  );

export class UpdateCompanyUserDto extends createZodDto(UpdateCompanyUserSchema) {}
