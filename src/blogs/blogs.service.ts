import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Blog, BlogStatus } from '../models/blogs/blog.entity';

export interface CreateBlogFromLinkedInPostInput {
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  sourcePostUrn: string;
  hashtags: string[];
  status: BlogStatus;
  publishedAt: Date | null;
}

@Injectable()
export class BlogsService {
  private readonly logger = new Logger(BlogsService.name);

  constructor(
    @InjectRepository(Blog)
    private readonly blogRepo: Repository<Blog>,
  ) {}

  async findAll(opts: { status?: BlogStatus } = {}): Promise<Blog[]> {
    return this.blogRepo.find({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Blog> {
    const blog = await this.blogRepo.findOne({ where: { id } });
    if (!blog) {
      throw new NotFoundException(`Blog ${id} not found`);
    }
    return blog;
  }

  async publish(id: string): Promise<Blog> {
    const blog = await this.findOne(id);
    blog.status = 'published';
    blog.publishedAt = blog.publishedAt ?? new Date();
    return this.blogRepo.save(blog);
  }

  async remove(id: string): Promise<void> {
    const result = await this.blogRepo.delete({ id });
    if (!result.affected) {
      throw new NotFoundException(`Blog ${id} not found`);
    }
  }

  /**
   * Idempotent insert keyed on sourcePostUrn: relies on the DB unique index (not an
   * app-level check) so concurrent/duplicate sync runs can never create two blogs for
   * one LinkedIn post. Returns created:false when the post was already converted.
   */
  async createFromLinkedInPostIfNew(
    input: CreateBlogFromLinkedInPostInput,
  ): Promise<{ blog: Blog | null; created: boolean }> {
    const result = await this.blogRepo
      .createQueryBuilder()
      .insert()
      .into(Blog)
      .values({
        title: input.title,
        slug: input.slug,
        content: input.content,
        excerpt: input.excerpt,
        coverImageUrl: input.coverImageUrl,
        sourcePostUrn: input.sourcePostUrn,
        hashtags: input.hashtags,
        status: input.status,
        source: 'linkedin',
        publishedAt: input.publishedAt,
      })
      .orIgnore()
      .returning('*')
      .execute();

    if (!result.identifiers.length) {
      this.logger.debug(`Blog for LinkedIn post ${input.sourcePostUrn} already exists, skipping`);
      return { blog: null, created: false };
    }

    return { blog: result.generatedMaps[0] as Blog, created: true };
  }
}
