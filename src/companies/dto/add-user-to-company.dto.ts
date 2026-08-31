import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CompanyRoles = ['owner', 'admin', 'member', 'user'] as const;

export const AddUserToCompanySchema = z.object({
  email: z
    .email('Invalid email format')
    .toLowerCase()
    .transform(email => email.trim()),
  companyRole: z
    .enum(CompanyRoles)
    .default('user')
    .describe(
      'Role within the company: owner (full access), admin (manage users & settings), member (can make calls), user (view only)',
    ),
  sendInviteEmail: z.boolean().default(true).describe('Send invitation email to the user'),
});

export class AddUserToCompanyDto extends createZodDto(AddUserToCompanySchema) {}
