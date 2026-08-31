export enum WebsiteBlogStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  UNPUBLISHED = 'unpublished',
}

export const WebsiteBlogStatusValues = [
  WebsiteBlogStatus.DRAFT,
  WebsiteBlogStatus.PUBLISHED,
  WebsiteBlogStatus.UNPUBLISHED,
] as const;
