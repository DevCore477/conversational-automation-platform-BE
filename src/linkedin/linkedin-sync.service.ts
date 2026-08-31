import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  LinkedInApiClient,
  LinkedInApiError,
  LinkedInPostDto,
  LinkedInPostView,
} from './linkedin-api.client';
import { LinkedInService } from './linkedin.service';
import {
  deriveExcerpt,
  deriveTitle,
  extractHashtags,
  isPublishableByHashtags,
  slugify,
} from './utils/linkedin-post-to-blog.util';
import linkedinConfig from '../configs/linkedin.config';
import { BlogsService } from '../blogs/blogs.service';
import { LinkedInOrganization } from '../models/linkedin/linkedin-organization.entity';
import { LinkedInPost } from '../models/linkedin/linkedin-post.entity';

@Injectable()
export class LinkedInSyncService {
  private readonly logger = new Logger(LinkedInSyncService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly linkedInService: LinkedInService,
    private readonly apiClient: LinkedInApiClient,
    private readonly blogsService: BlogsService,
    @InjectRepository(LinkedInPost)
    private readonly postRepo: Repository<LinkedInPost>,
  ) {}

  private cfg() {
    return this.configService.getOrThrow<ConfigType<typeof linkedinConfig>>('linkedin');
  }

  /** Every 30 minutes by default (LINKEDIN_SYNC_CRON). There is only ever one connected organization. */
  @Cron(process.env.LINKEDIN_SYNC_CRON ?? '*/30 * * * *')
  async syncAll(): Promise<void> {
    const org = await this.linkedInService.getActiveOrganization();
    if (!org) {
      return;
    }

    try {
      const created = await this.syncOrganization(org);
      await this.linkedInService.markSyncResult(org, null);
      if (created > 0) {
        this.logger.log(`Synced ${org.organizationUrn}: ${String(created)} new blog(s) created`);
      }
    } catch (err) {
      await this.handleSyncFailure(org, err);
    }
  }

  private async handleSyncFailure(org: LinkedInOrganization, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof LinkedInApiError && (err.status === 401 || err.status === 403)) {
      await this.linkedInService.markNeedsReconnect(org, message);
      return;
    }

    this.logger.error(`LinkedIn sync failed for ${org.organizationUrn}: ${message}`);
    await this.linkedInService.markSyncResult(org, message);
  }

  /**
   * Walks pages newest-first and stops at the first already-ingested post — this both
   * limits API usage and guarantees only new posts are fetched. Returns blogs created.
   */
  private async syncOrganization(org: LinkedInOrganization): Promise<number> {
    const cfg = this.cfg();
    const accessToken = await this.linkedInService.getValidAccessToken(org);

    let start = 0;
    let blogsCreated = 0;

    for (let page = 0; page < cfg.maxPagesPerSync; page += 1) {
      const { elements } = await this.apiClient.fetchOrganizationPosts(
        org.organizationUrn,
        accessToken,
        { start, count: cfg.postsPageSize },
      );

      if (elements.length === 0) {
        break;
      }

      let sawKnownPost = false;
      for (const post of elements) {
        const { isNew, blogCreated } = await this.ingestPost(org, post, accessToken);
        if (blogCreated) blogsCreated += 1;
        if (!isNew) sawKnownPost = true;
      }

      if (sawKnownPost || elements.length < cfg.postsPageSize) {
        break;
      }
      start += cfg.postsPageSize;
    }

    return blogsCreated;
  }

  /** Idempotent per-post ingest: DB unique index on (organizationId, postUrn) is the real dedupe guard. */
  private async ingestPost(
    org: LinkedInOrganization,
    post: LinkedInPostDto,
    accessToken: string,
  ): Promise<{ isNew: boolean; blogCreated: boolean }> {
    if (post.author !== org.organizationUrn) {
      // Defense in depth: only ever accept posts authored by the connected company page.
      return { isNew: false, blogCreated: false };
    }

    const hashtags = extractHashtags(post.commentary);
    const view = await this.apiClient.toPostView(post, accessToken);

    const insertResult = await this.postRepo
      .createQueryBuilder()
      .insert()
      .into(LinkedInPost)
      .values({
        organizationId: org.id,
        postUrn: post.id,
        commentary: post.commentary ?? null,
        hashtags,
        publishedAt: view.publishedAt,
        postUrl: view.postUrl,
        imageUrls: view.images,
        videoUrls: view.videos,
        engagement: view.engagement,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- TypeORM's DeepPartial can't map a Record<string, unknown> jsonb column
        rawPayload: post as any,
      })
      .orIgnore()
      .execute();

    if (!insertResult.identifiers.length) {
      return { isNew: false, blogCreated: false };
    }

    this.logger.log(
      `Ingested LinkedIn post ${post.id}: ${String(view.images.length)} image(s), ` +
        `${String(view.videos.length)} video(s), engagement=${JSON.stringify(view.engagement)}`,
    );

    const postRowId = insertResult.identifiers[0].id as string;
    const blogCreated = await this.convertToBlog(org, post, hashtags, view, postRowId);
    return { isNew: true, blogCreated };
  }

  private async convertToBlog(
    org: LinkedInOrganization,
    post: LinkedInPostDto,
    hashtags: string[],
    view: LinkedInPostView,
    postRowId: string,
  ): Promise<boolean> {
    const cfg = this.cfg();
    const title = deriveTitle(post.commentary, `LinkedIn update — ${org.organizationUrn}`);
    const publishable = isPublishableByHashtags(hashtags, cfg.publishHashtag);

    const { blog } = await this.blogsService.createFromLinkedInPostIfNew({
      title,
      slug: slugify(title, post.id),
      content: post.commentary ?? '',
      excerpt: deriveExcerpt(post.commentary),
      coverImageUrl: view.images[0] ?? null,
      sourcePostUrn: post.id,
      hashtags,
      status: publishable ? 'published' : 'draft',
      publishedAt: publishable && view.publishedAt ? view.publishedAt : null,
    });

    await this.postRepo.update(
      { id: postRowId },
      { blogId: blog?.id ?? null, processedAt: new Date() },
    );

    return !!blog;
  }
}
