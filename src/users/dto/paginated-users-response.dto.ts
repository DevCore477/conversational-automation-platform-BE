import { ApiProperty } from '@nestjs/swagger';

import { UserResponseDto } from './user-response.dto';

/** Aggregates for the same `search` as the list; `role` query filter does not affect these counts. */
export class MembersListCountsDto {
  @ApiProperty({
    description:
      'Number of users matching `search` (if any). Ignores the `role` filter so you always see totals for the current search scope.',
    example: 48,
  })
  matchingSearchTotal: number;

  @ApiProperty({
    description: 'Users with platform role `admin` within the search scope',
    example: 2,
  })
  platformAdmin: number;

  @ApiProperty({
    description: 'Users with platform role `member` within the search scope',
    example: 46,
  })
  platformMember: number;

  @ApiProperty({ description: 'Users assigned to a company (`companyId` set)', example: 40 })
  withCompany: number;

  @ApiProperty({ description: 'Users with no company', example: 8 })
  withoutCompany: number;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  currentPage: number;

  @ApiProperty({ example: 10 })
  itemsPerPage: number;

  @ApiProperty({ example: 50 })
  totalItems: number;

  @ApiProperty({ example: 5 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage: boolean;

  @ApiProperty({ type: MembersListCountsDto })
  counts: MembersListCountsDto;
}

export class PaginatedUsersResponseDto {
  @ApiProperty({ type: [UserResponseDto] })
  data: UserResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
