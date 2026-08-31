import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { WebsiteBlogStatus } from '../../website-blogs/enums/website-blog-status.enum';

/**
 * Editorial blog posts for the public marketing website, authored by Super Admins.
 * Deliberately separate from `Blog` (src/models/blogs) which is the LinkedIn-integration's
 * auto-generated post feed — the two must never share a table or entity.
 */
@Entity('website_blogs')
export class WebsiteBlog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 280 })
  slug: string;

  @Column({ type: 'varchar', length: 500 })
  shortDescription: string;

  /** Sanitized HTML produced by the admin dashboard's rich-text editor. */
  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  featuredImage: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  images: string[];

  @Column({ type: 'varchar', length: 150 })
  authorName: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags: string[];

  @Index()
  @Column({ type: 'varchar', length: 20, default: WebsiteBlogStatus.DRAFT })
  status: WebsiteBlogStatus;

  /**
   * Set the first time a blog is published and retained afterwards — unpublishing does not
   * clear it, so the original publish date/SEO history survives a later re-publish.
   */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  metaTitle: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  metaDescription: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  metaKeywords: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  canonicalUrl: string | null;

  /** Audit only — the Super Admin user who created this post. Never exposed publicly. */
  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  /** Soft delete: hidden from all listings/lookups once set, row kept for audit. */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
