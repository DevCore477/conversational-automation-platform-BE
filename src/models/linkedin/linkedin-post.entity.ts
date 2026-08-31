import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { LinkedInOrganization } from './linkedin-organization.entity';
import { Blog } from '../blogs/blog.entity';

/**
 * Ledger of every LinkedIn post ever ingested for an organization.
 * The unique (organizationId, postUrn) index is the source of truth for de-duplication —
 * it is what makes the sync cron idempotent even if two instances race.
 */
@Entity('linkedin_posts')
@Index(['organizationId', 'postUrn'], { unique: true })
export class LinkedInPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  organizationId: string;

  @ManyToOne(() => LinkedInOrganization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization?: LinkedInOrganization;

  /** e.g. "urn:li:share:12345" / "urn:li:ugcPost:12345" from LinkedIn's Posts API. */
  @Column({ type: 'varchar', length: 255 })
  postUrn: string;

  @Column({ type: 'text', nullable: true })
  commentary: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  hashtags: string[];

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /** Canonical public LinkedIn URL for this post, e.g. https://www.linkedin.com/feed/update/{urn}/ */
  @Column({ type: 'varchar', length: 500, nullable: true })
  postUrl: string | null;

  /** Resolved, directly-loadable image URLs (from content.media / content.multiImage). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  imageUrls: string[];

  /** Resolved, directly-loadable video URLs (from content.media when it's a video asset). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  videoUrls: string[];

  /** Best-effort like/comment/share counts at ingest time — from /rest/socialActions; not live. */
  @Column({ type: 'jsonb', nullable: true })
  engagement: { likes: number; comments: number; shares: number } | null;

  /** Full API response for the post, kept for debugging/reprocessing. */
  @Column({ type: 'jsonb' })
  rawPayload: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true })
  blogId: string | null;

  @ManyToOne(() => Blog, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'blogId' })
  blog?: Blog | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
