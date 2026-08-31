import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const NewsletterStatusEnum = ['subscribed', 'unsubscribed'] as const;

@Entity('newsletter_subscribers')
export class NewsletterSubscriber {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 50, default: 'subscribed' })
  status: (typeof NewsletterStatusEnum)[number];

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  unsubscribeToken: string;

  @Column({ type: 'timestamptz', nullable: true })
  subscribedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  unsubscribedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
