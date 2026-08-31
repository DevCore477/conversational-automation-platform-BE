import { ApiProperty } from '@nestjs/swagger';

import { CompanyUserStatus, UserRole } from '../../common/enums';

/** Derived from `companyRole` (same rules as API authorization checks). */
export class CompanyMemberPermissionsDto {
  @ApiProperty()
  manageCompanyProfile: boolean;

  @ApiProperty()
  manageThemeAndBranding: boolean;

  @ApiProperty()
  manageCompanySettings: boolean;

  @ApiProperty()
  manageUsers: boolean;

  @ApiProperty()
  manageInvitations: boolean;

  @ApiProperty()
  assignOwnerRole: boolean;

  @ApiProperty()
  manageApiKeys: boolean;

  @ApiProperty()
  removeUsers: boolean;

  @ApiProperty()
  makeCalls: boolean;

  @ApiProperty()
  viewCompanyAndAnalytics: boolean;
}

export class CompanyUserDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: 'john.doe@example.com' })
  email: string;

  @ApiProperty({ example: 'John' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  lastName: string;

  @ApiProperty({ enum: UserRole, example: UserRole.MEMBER })
  role: UserRole;

  @ApiProperty({ example: 'admin' })
  companyRole: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Tenant id when the user belongs to a company',
  })
  companyId?: string | null;

  @ApiProperty({ type: CompanyMemberPermissionsDto })
  permissions: CompanyMemberPermissionsDto;

  @ApiProperty({ enum: CompanyUserStatus, example: CompanyUserStatus.ACTIVE, required: false })
  companyStatus?: CompanyUserStatus;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  updatedAt: Date;
}

export class PendingInvitationDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: 'jane.doe@example.com' })
  email: string;

  @ApiProperty({ example: 'member' })
  companyRole: string;

  @ApiProperty({
    type: CompanyMemberPermissionsDto,
    description: 'Permissions the invitee will receive once they accept.',
  })
  permissions: CompanyMemberPermissionsDto;

  @ApiProperty({ example: 'admin@example.com', required: false })
  invitedBy?: string;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  expiresAt: Date;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  createdAt: Date;
}

export class CompanyUsersResponseDto {
  @ApiProperty({ type: [CompanyUserDto] })
  users: CompanyUserDto[];

  @ApiProperty({ type: [PendingInvitationDto] })
  pendingInvitations: PendingInvitationDto[];
}
