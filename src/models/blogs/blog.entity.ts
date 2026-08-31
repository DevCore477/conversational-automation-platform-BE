import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type BlogStatus = 'draft' | 'published';
export type BlogSource = 'linkedin' | 'manual';

/** Public blog posts shown on the Hexa AI website — not scoped to a tenant company. */
@Entity('blogs')
export class Blog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 280 })
  slug: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  excerpt: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  coverImageUrl: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: BlogStatus;

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  source: BlogSource;

  /**
   * LinkedIn post URN this blog was generated from. Unique so a re-run of the sync
   * cron can never create a second blog for the same post (idempotency guarantee).
   */
  @Index({ unique: true, where: '"sourcePostUrn" IS NOT NULL' })
  @Column({ type: 'varchar', length: 255, nullable: true })
  sourcePostUrn: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  hashtags: string[];

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
