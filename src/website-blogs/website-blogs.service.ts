import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';

import { CreateWebsiteBlogInput } from './dto/create-website-blog.dto';
import { UpdateWebsiteBlogInput } from './dto/update-website-blog.dto';
import { WebsiteBlogStatus } from './enums/website-blog-status.enum';
import { escapeHtml } from './utils/html-escape.util';
import { slugifyTitle } from './utils/website-blog-slug.util';
import { WebsiteBlog } from '../models/website-blogs/website-blog.entity';
import { NewsletterService } from '../newsletter/newsletter.service';

export interface AdminListWebsiteBlogsOptions {
  page: number;
  limit: number;
  search?: string;
  status?: WebsiteBlogStatus;
  category?: string;
}

export interface PublicListWebsiteBlogsOptions {
  page: number;
  limit: number;
  search?: string;
  category?: string;
  tag?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
}

@Injectable()
export class WebsiteBlogsService {
  private readonly logger = new Logger(WebsiteBlogsService.name);

  constructor(
    @InjectRepository(WebsiteBlog)
    private readonly repo: Repository<WebsiteBlog>,
    private readonly newsletterService: NewsletterService,
    private readonly config: ConfigService,
  ) {}

  async create(
    input: CreateWebsiteBlogInput,
    createdByUserId: string | null,
  ): Promise<WebsiteBlog> {
    const slug = input.slug
      ? await this.assertSlugAvailable(input.slug)
      : await this.generateUniqueSlug(slugifyTitle(input.title));

    const blog = this.repo.create({
      title: input.title,
      slug,
      shortDescription: input.shortDescription,
      content: input.content,
      featuredImage: input.featuredImage ?? null,
      images: input.images,
      authorName: input.authorName,
      category: input.category ?? null,
      tags: input.tags,
      status: WebsiteBlogStatus.DRAFT,
      publishedAt: null,
      metaTitle: input.metaTitle ?? null,
      metaDescription: input.metaDescription ?? null,
      metaKeywords: input.metaKeywords ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      createdByUserId,
    });

    const isNewlyPublished = input.status ? this.applyStatus(blog, input.status) : false;

    const saved = await this.repo.save(blog);
    if (isNewlyPublished) {
      await this.notifySubscribers(saved);
    }
    return saved;
  }

  async findAllAdmin(opts: AdminListWebsiteBlogsOptions): Promise<PaginatedResult<WebsiteBlog>> {
    const qb = this.repo.createQueryBuilder('blog').where('blog.deletedAt IS NULL');

    this.applySearch(qb, opts.search);

    if (opts.status) {
      qb.andWhere('blog.status = :status', { status: opts.status });
    }
    if (opts.category) {
      qb.andWhere('blog.category = :category', { category: opts.category });
    }

    qb.orderBy('blog.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async findOneAdmin(id: string): Promise<WebsiteBlog> {
    const blog = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!blog) {
      throw new NotFoundException(`Website blog ${id} not found`);
    }
    return blog;
  }

  async update(id: string, input: UpdateWebsiteBlogInput): Promise<WebsiteBlog> {
    const blog = await this.findOneAdmin(id);

    if (input.slug && input.slug !== blog.slug) {
      blog.slug = await this.assertSlugAvailable(input.slug, blog.id);
    }
    if (input.title !== undefined) blog.title = input.title;
    if (input.shortDescription !== undefined) blog.shortDescription = input.shortDescription;
    if (input.content !== undefined) blog.content = input.content;
    if (input.featuredImage !== undefined) blog.featuredImage = input.featuredImage;
    if (input.images !== undefined) blog.images = input.images;
    if (input.authorName !== undefined) blog.authorName = input.authorName;
    if (input.category !== undefined) blog.category = input.category;
    if (input.tags !== undefined) blog.tags = input.tags;
    if (input.metaTitle !== undefined) blog.metaTitle = input.metaTitle;
    if (input.metaDescription !== undefined) blog.metaDescription = input.metaDescription;
    if (input.metaKeywords !== undefined) blog.metaKeywords = input.metaKeywords;
    if (input.canonicalUrl !== undefined) blog.canonicalUrl = input.canonicalUrl;

    const isNewlyPublished =
      input.status !== undefined ? this.applyStatus(blog, input.status) : false;

    const saved = await this.repo.save(blog);
    if (isNewlyPublished) {
      await this.notifySubscribers(saved);
    }
    return saved;
  }

  async remove(id: string): Promise<void> {
    const blog = await this.findOneAdmin(id);
    blog.deletedAt = new Date();
    await this.repo.save(blog);
  }

  async publish(id: string): Promise<WebsiteBlog> {
    const blog = await this.findOneAdmin(id);
    const isNewlyPublished = this.applyStatus(blog, WebsiteBlogStatus.PUBLISHED);
    const saved = await this.repo.save(blog);
    if (isNewlyPublished) {
      await this.notifySubscribers(saved);
    }
    return saved;
  }

  async unpublish(id: string): Promise<WebsiteBlog> {
    const blog = await this.findOneAdmin(id);
    this.applyStatus(blog, WebsiteBlogStatus.UNPUBLISHED);
    return this.repo.save(blog);
  }

  async findPublished(opts: PublicListWebsiteBlogsOptions): Promise<PaginatedResult<WebsiteBlog>> {
    const qb = this.repo
      .createQueryBuilder('blog')
      .where('blog.deletedAt IS NULL')
      .andWhere('blog.status = :status', { status: WebsiteBlogStatus.PUBLISHED });

    this.applySearch(qb, opts.search);

    if (opts.category) {
      qb.andWhere('blog.category = :category', { category: opts.category });
    }
    if (opts.tag) {
      qb.andWhere('blog.tags @> :tag', { tag: JSON.stringify([opts.tag]) });
    }

    qb.orderBy('blog.publishedAt', 'DESC')
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async findPublishedBySlug(slug: string): Promise<WebsiteBlog> {
    const blog = await this.repo.findOne({
      where: { slug, status: WebsiteBlogStatus.PUBLISHED, deletedAt: IsNull() },
    });
    if (!blog) {
      throw new NotFoundException(`Blog "${slug}" not found`);
    }
    return blog;
  }

  /** Returns true only the first time a blog transitions into PUBLISHED — the trigger for a newsletter send. */
  private applyStatus(blog: WebsiteBlog, status: WebsiteBlogStatus): boolean {
    const isNewlyPublished = status === WebsiteBlogStatus.PUBLISHED && blog.publishedAt === null;
    blog.status = status;
    if (status === WebsiteBlogStatus.PUBLISHED) {
      blog.publishedAt = blog.publishedAt ?? new Date();
    }
    // Unpublishing intentionally retains publishedAt — see WebsiteBlog entity doc comment.
    return isNewlyPublished;
  }

  /**
   * Announces a newly-published post to active newsletter subscribers via the existing
   * NewsletterService broadcast pipeline (queued, retried, per-subscriber delivery tracked
   * on a NewsletterCampaign row). Only ever called once per post — on its first publish,
   * not on every re-publish — so subscribers never get duplicate emails for the same post.
   * A broadcast failure must never fail the publish request itself, so errors are logged
   * and swallowed here.
   */
  private async notifySubscribers(blog: WebsiteBlog): Promise<void> {
    try {
      const url = this.publicBlogUrl(blog.slug);
      const html = this.buildAnnouncementHtml(blog, url);
      await this.newsletterService.broadcast(`New on the blog: ${blog.title}`, html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Blog "${blog.slug}" published but newsletter broadcast failed: ${message}`);
    }
  }

  private publicBlogUrl(slug: string): string {
    const base = this.config.get<string>('auth.frontendBaseUrl') ?? '';
    return `${base.replace(/\/$/, '')}/blog/${slug}`;
  }

  /** Rendered into the `{{content}}` slot of the existing newsletter_broadcast_email.html template. */
  private buildAnnouncementHtml(blog: WebsiteBlog, url: string): string {
    const imageHtml = blog.featuredImage
      ? `<p><img src="${escapeHtml(blog.featuredImage)}" alt="${escapeHtml(blog.title)}" style="width:100%;max-width:520px;border-radius:8px;display:block;" /></p>`
      : '';
    const categoryHtml = blog.category
      ? `<p style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">${escapeHtml(blog.category)}</p>`
      : '';

    return [
      categoryHtml,
      imageHtml,
      `<p>${escapeHtml(blog.shortDescription)}</p>`,
      `<p style="color:#666666;">By ${escapeHtml(blog.authorName)}</p>`,
      `<p><a href="${url}">Read the full article &rarr;</a></p>`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private applySearch(qb: SelectQueryBuilder<WebsiteBlog>, search: string | undefined): void {
    if (!search) return;
    qb.andWhere('(blog.title ILIKE :search OR blog.shortDescription ILIKE :search)', {
      search: `%${search}%`,
    });
  }

  private async assertSlugAvailable(slug: string, excludeId?: string): Promise<string> {
    const exists = await this.slugExists(slug, excludeId);
    if (exists) {
      throw new ConflictException(`Slug "${slug}" is already in use`);
    }
    return slug;
  }

  private async generateUniqueSlug(base: string): Promise<string> {
    let candidate = base;
    let suffix = 1;
    while (await this.slugExists(candidate)) {
      suffix += 1;
      candidate = `${base}-${String(suffix)}`;
    }
    return candidate;
  }

  private async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const count = await this.repo.count({
      where: excludeId ? { slug, id: Not(excludeId) } : { slug },
    });
    return count > 0;
  }
}
