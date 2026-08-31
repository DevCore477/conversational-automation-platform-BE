import { ApiProperty } from '@nestjs/swagger';

import { WebsiteBlogStatus } from '../enums/website-blog-status.enum';

export class WebsiteBlogPaginationMetaDto {
  @ApiProperty({ example: 1 })
  currentPage: number;

  @ApiProperty({ example: 10 })
  itemsPerPage: number;

  @ApiProperty({ example: 42 })
  totalItems: number;

  @ApiProperty({ example: 5 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage: boolean;
}

/** Card/listing shape — deliberately excludes `content` and internal-only fields. */
export class WebsiteBlogListItemDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty() shortDescription: string;
  @ApiProperty({ nullable: true }) featuredImage: string | null;
  @ApiProperty({ nullable: true }) category: string | null;
  @ApiProperty({ type: [String] }) tags: string[];
  @ApiProperty({ nullable: true }) publishedAt: Date | null;
  @ApiProperty() authorName: string;
}

/** Public single-post shape — full content + SEO fields, no internal/admin-only fields. */
export class WebsiteBlogPublicDetailDto extends WebsiteBlogListItemDto {
  @ApiProperty() content: string;
  @ApiProperty({ type: [String] }) images: string[];
  @ApiProperty({ nullable: true }) metaTitle: string | null;
  @ApiProperty({ nullable: true }) metaDescription: string | null;
  @ApiProperty({ nullable: true }) metaKeywords: string | null;
  @ApiProperty({ nullable: true }) canonicalUrl: string | null;
}

/** Admin single-post shape — everything, including status/timestamps for editing. */
export class WebsiteBlogAdminDetailDto extends WebsiteBlogPublicDetailDto {
  @ApiProperty({ enum: WebsiteBlogStatus }) status: WebsiteBlogStatus;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class PaginatedWebsiteBlogsResponseDto {
  @ApiProperty({ type: [WebsiteBlogListItemDto] })
  data: WebsiteBlogListItemDto[];

  @ApiProperty({ type: WebsiteBlogPaginationMetaDto })
  meta: WebsiteBlogPaginationMetaDto;
}
