import {
  WebsiteBlogAdminDetailDto,
  WebsiteBlogListItemDto,
  WebsiteBlogPublicDetailDto,
} from './dto/website-blog-response.dto';
import { WebsiteBlog } from '../models/website-blogs/website-blog.entity';

export function toListItem(blog: WebsiteBlog): WebsiteBlogListItemDto {
  return {
    id: blog.id,
    title: blog.title,
    slug: blog.slug,
    shortDescription: blog.shortDescription,
    featuredImage: blog.featuredImage,
    category: blog.category,
    tags: blog.tags,
    publishedAt: blog.publishedAt,
    authorName: blog.authorName,
  };
}

export function toPublicDetail(blog: WebsiteBlog): WebsiteBlogPublicDetailDto {
  return {
    id: blog.id,
    title: blog.title,
    slug: blog.slug,
    shortDescription: blog.shortDescription,
    featuredImage: blog.featuredImage,
    category: blog.category,
    tags: blog.tags,
    publishedAt: blog.publishedAt,
    authorName: blog.authorName,
    content: blog.content,
    images: blog.images,
    metaTitle: blog.metaTitle,
    metaDescription: blog.metaDescription,
    metaKeywords: blog.metaKeywords,
    canonicalUrl: blog.canonicalUrl,
  };
}

export function toAdminDetail(blog: WebsiteBlog): WebsiteBlogAdminDetailDto {
  return {
    id: blog.id,
    title: blog.title,
    slug: blog.slug,
    shortDescription: blog.shortDescription,
    featuredImage: blog.featuredImage,
    category: blog.category,
    tags: blog.tags,
    publishedAt: blog.publishedAt,
    authorName: blog.authorName,
    content: blog.content,
    images: blog.images,
    metaTitle: blog.metaTitle,
    metaDescription: blog.metaDescription,
    metaKeywords: blog.metaKeywords,
    canonicalUrl: blog.canonicalUrl,
    status: blog.status,
    createdAt: blog.createdAt,
    updatedAt: blog.updatedAt,
  };
}
