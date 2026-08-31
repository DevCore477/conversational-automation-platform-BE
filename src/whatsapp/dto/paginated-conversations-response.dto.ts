import { ApiProperty } from '@nestjs/swagger';

export class ConversationsPaginationMetaDto {
  @ApiProperty({ example: 1 })
  currentPage: number;

  @ApiProperty({ example: 20 })
  itemsPerPage: number;

  @ApiProperty({ example: 48 })
  totalItems: number;

  @ApiProperty({ example: 3 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage: boolean;
}

export class PaginatedConversationsResponseDto {
  @ApiProperty({ description: 'Conversation rows for the current page' })
  data: unknown[];

  @ApiProperty({ type: ConversationsPaginationMetaDto })
  meta: ConversationsPaginationMetaDto;
}
