import { ApiProperty } from '@nestjs/swagger';

import { UserRole, CompanyUserStatus } from '../../common/enums';

export class UserResponseDto {
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

  @ApiProperty({ required: false, nullable: true })
  companyId?: string | null;

  @ApiProperty({ example: 'admin', required: false })
  companyRole?: string;

  @ApiProperty({ enum: CompanyUserStatus, example: CompanyUserStatus.ACTIVE, required: false })
  companyStatus?: CompanyUserStatus;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  updatedAt: Date;
}
