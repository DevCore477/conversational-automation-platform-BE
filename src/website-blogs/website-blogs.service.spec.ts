import { ConflictException, NotFoundException } from '@nestjs/common';

import { WebsiteBlogStatus } from './enums/website-blog-status.enum';
import { WebsiteBlogsService } from './website-blogs.service';
import { WebsiteBlog } from '../models/website-blogs/website-blog.entity';

interface MockRepo {
  create: jest.Mock<Partial<WebsiteBlog>, [Partial<WebsiteBlog>]>;
  save: jest.Mock<Promise<WebsiteBlog>, [WebsiteBlog]>;
  findOne: jest.Mock<Promise<WebsiteBlog | undefined>, [{ where: Record<string, unknown> }]>;
  count: jest.Mock<Promise<number>, [{ where: Record<string, unknown> }]>;
  createQueryBuilder: jest.Mock;
}

function makeBlog(overrides: Partial<WebsiteBlog> = {}): WebsiteBlog {
  return {
    id: 'blog-1',
    title: 'Hello World',
    slug: 'hello-world',
    shortDescription: 'short',
    content: '<p>content</p>',
    featuredImage: null,
    images: [],
    authorName: 'Hexa AI Team',
    category: null,
    tags: [],
    status: WebsiteBlogStatus.DRAFT,
    publishedAt: null,
    metaTitle: null,
    metaDescription: null,
    metaKeywords: null,
    canonicalUrl: null,
    createdByUserId: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeQueryBuilder(data: WebsiteBlog[], total: number) {
  const qb: Record<string, jest.Mock> = {};
  const chainable = ['where', 'andWhere', 'orderBy', 'skip', 'take'];
  chainable.forEach(method => {
    qb[method] = jest.fn().mockReturnValue(qb);
  });
  qb.getManyAndCount = jest.fn().mockResolvedValue([data, total]);
  return qb;
}

describe('WebsiteBlogsService', () => {
  let repo: MockRepo;
  let newsletterService: { broadcast: jest.Mock };
  let config: { get: jest.Mock };
  let service: WebsiteBlogsService;

  beforeEach(() => {
    repo = {
      create: jest.fn((input: Partial<WebsiteBlog>) => input),
      save: jest.fn((blog: WebsiteBlog) => Promise.resolve(blog)),
      findOne: jest.fn<Promise<WebsiteBlog | undefined>, [{ where: Record<string, unknown> }]>(),
      count: jest.fn<Promise<number>, [{ where: Record<string, unknown> }]>().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    newsletterService = {
      broadcast: jest.fn().mockResolvedValue({ id: 'campaign-1' }),
    };
    config = {
      get: jest.fn().mockReturnValue('https://gethexa.ai'),
    };
    service = new WebsiteBlogsService(repo as never, newsletterService as never, config as never);
  });

  describe('create', () => {
    it('creates a draft blog with an auto-generated slug when none is supplied', async () => {
      const blog = await service.create(
        {
          title: 'My First Post',
          shortDescription: 'desc',
          content: '<p>hi</p>',
          authorName: 'Admin',
          images: [],
          tags: [],
        } as never,
        'user-1',
      );

      expect(repo.count).toHaveBeenCalled();
      expect(blog.slug).toBe('my-first-post');
      expect(blog.status).toBe(WebsiteBlogStatus.DRAFT);
      expect(blog.publishedAt).toBeNull();
      expect(blog.createdByUserId).toBe('user-1');
    });

    it('de-duplicates the slug when the base slug is already taken', async () => {
      repo.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      const blog = await service.create(
        {
          title: 'My First Post',
          shortDescription: 'desc',
          content: '<p>hi</p>',
          authorName: 'Admin',
          images: [],
          tags: [],
        } as never,
        'user-1',
      );

      expect(blog.slug).toBe('my-first-post-2');
    });

    it('sets publishedAt immediately when created directly as published', async () => {
      const blog = await service.create(
        {
          title: 'Launch Day',
          shortDescription: 'desc',
          content: '<p>hi</p>',
          authorName: 'Admin',
          status: WebsiteBlogStatus.PUBLISHED,
          images: [],
          tags: [],
        } as never,
        'user-1',
      );

      expect(blog.status).toBe(WebsiteBlogStatus.PUBLISHED);
      expect(blog.publishedAt).toBeInstanceOf(Date);
    });

    it('broadcasts a newsletter announcement when created directly as published', async () => {
      await service.create(
        {
          title: 'Launch Day',
          shortDescription: 'desc',
          content: '<p>hi</p>',
          authorName: 'Admin',
          status: WebsiteBlogStatus.PUBLISHED,
          images: [],
          tags: [],
        } as never,
        'user-1',
      );

      expect(newsletterService.broadcast).toHaveBeenCalledTimes(1);
      expect(newsletterService.broadcast).toHaveBeenCalledWith(
        'New on the blog: Launch Day',
        expect.stringContaining('desc'),
      );
    });

    it('does not broadcast when created as a draft', async () => {
      await service.create(
        {
          title: 'Draft Post',
          shortDescription: 'desc',
          content: '<p>hi</p>',
          authorName: 'Admin',
          images: [],
          tags: [],
        } as never,
        'user-1',
      );

      expect(newsletterService.broadcast).not.toHaveBeenCalled();
    });

    it('rejects an explicitly supplied slug that is already in use', async () => {
      repo.count.mockResolvedValueOnce(1);

      await expect(
        service.create(
          {
            title: 'Post',
            slug: 'taken-slug',
            shortDescription: 'desc',
            content: '<p>hi</p>',
            authorName: 'Admin',
            images: [],
            tags: [],
          } as never,
          'user-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('publish / unpublish', () => {
    it('publish sets publishedAt the first time', async () => {
      repo.findOne.mockResolvedValue(makeBlog({ status: WebsiteBlogStatus.DRAFT }));

      const blog = await service.publish('blog-1');

      expect(blog.status).toBe(WebsiteBlogStatus.PUBLISHED);
      expect(blog.publishedAt).toBeInstanceOf(Date);
    });

    it('broadcasts a newsletter announcement on first publish', async () => {
      repo.findOne.mockResolvedValue(
        makeBlog({
          status: WebsiteBlogStatus.DRAFT,
          slug: 'hello-world',
          featuredImage: 'https://cdn.example.com/hero.png',
          category: 'Product',
        }),
      );

      await service.publish('blog-1');

      expect(newsletterService.broadcast).toHaveBeenCalledTimes(1);
      const [subject, html] = newsletterService.broadcast.mock.calls[0] as [string, string];
      expect(subject).toBe('New on the blog: Hello World');
      expect(html).toContain('https://cdn.example.com/hero.png');
      expect(html).toContain('Product');
      expect(html).toContain('https://gethexa.ai/blog/hello-world');
    });

    it('publish does not overwrite an existing publishedAt', async () => {
      const originalDate = new Date('2020-01-01T00:00:00Z');
      repo.findOne.mockResolvedValue(
        makeBlog({ status: WebsiteBlogStatus.UNPUBLISHED, publishedAt: originalDate }),
      );

      const blog = await service.publish('blog-1');

      expect(blog.publishedAt).toBe(originalDate);
    });

    it('does not re-broadcast when re-publishing a previously-published post', async () => {
      const originalDate = new Date('2020-01-01T00:00:00Z');
      repo.findOne.mockResolvedValue(
        makeBlog({ status: WebsiteBlogStatus.UNPUBLISHED, publishedAt: originalDate }),
      );

      await service.publish('blog-1');

      expect(newsletterService.broadcast).not.toHaveBeenCalled();
    });

    it('unpublish retains publishedAt rather than clearing it', async () => {
      const originalDate = new Date('2020-01-01T00:00:00Z');
      repo.findOne.mockResolvedValue(
        makeBlog({ status: WebsiteBlogStatus.PUBLISHED, publishedAt: originalDate }),
      );

      const blog = await service.unpublish('blog-1');

      expect(blog.status).toBe(WebsiteBlogStatus.UNPUBLISHED);
      expect(blog.publishedAt).toBe(originalDate);
    });

    it('does not broadcast on unpublish', async () => {
      repo.findOne.mockResolvedValue(
        makeBlog({ status: WebsiteBlogStatus.PUBLISHED, publishedAt: new Date() }),
      );

      await service.unpublish('blog-1');

      expect(newsletterService.broadcast).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing blog', async () => {
      repo.findOne.mockResolvedValue(undefined);

      await expect(service.publish('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not let a newsletter broadcast failure fail the publish request', async () => {
      repo.findOne.mockResolvedValue(makeBlog({ status: WebsiteBlogStatus.DRAFT }));
      newsletterService.broadcast.mockRejectedValueOnce(new Error('SMTP down'));

      const blog = await service.publish('blog-1');

      expect(blog.status).toBe(WebsiteBlogStatus.PUBLISHED);
    });
  });

  describe('remove', () => {
    it('soft-deletes by setting deletedAt', async () => {
      repo.findOne.mockResolvedValue(makeBlog());

      await service.remove('blog-1');

      const savedArg = repo.save.mock.calls[0][0];
      expect(savedArg.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('findPublishedBySlug', () => {
    it('returns the blog when found', async () => {
      const blog = makeBlog({ status: WebsiteBlogStatus.PUBLISHED });
      repo.findOne.mockResolvedValue(blog);

      await expect(service.findPublishedBySlug('hello-world')).resolves.toBe(blog);
      const callArg = repo.findOne.mock.calls[0][0];
      expect(callArg.where.slug).toBe('hello-world');
      expect(callArg.where.status).toBe('published');
    });

    it('throws NotFoundException when no published blog matches (draft hidden from public API)', async () => {
      repo.findOne.mockResolvedValue(undefined);

      await expect(service.findPublishedBySlug('draft-post')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findPublished (public listing)', () => {
    it('scopes the query to published, non-deleted posts', async () => {
      const qb = makeQueryBuilder([makeBlog({ status: WebsiteBlogStatus.PUBLISHED })], 1);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findPublished({ page: 1, limit: 10 });

      expect(qb.where).toHaveBeenCalledWith('blog.deletedAt IS NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('blog.status = :status', {
        status: WebsiteBlogStatus.PUBLISHED,
      });
      expect(result.total).toBe(1);
    });
  });

  describe('findAllAdmin', () => {
    it('includes drafts and applies the status filter when given', async () => {
      const qb = makeQueryBuilder([makeBlog({ status: WebsiteBlogStatus.DRAFT })], 1);
      repo.createQueryBuilder.mockReturnValue(qb);

      await service.findAllAdmin({ page: 1, limit: 10, status: WebsiteBlogStatus.DRAFT });

      expect(qb.andWhere).toHaveBeenCalledWith('blog.status = :status', {
        status: WebsiteBlogStatus.DRAFT,
      });
    });
  });

  describe('update', () => {
    it('rejects updating to a slug already used by another blog', async () => {
      repo.findOne.mockResolvedValue(makeBlog());
      repo.count.mockResolvedValueOnce(1);

      await expect(
        service.update('blog-1', { slug: 'someone-elses-slug' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException when the blog was soft-deleted', async () => {
      repo.findOne.mockResolvedValue(undefined);

      await expect(service.update('blog-1', { title: 'x' } as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('broadcasts a newsletter announcement when a draft is updated to published', async () => {
      repo.findOne.mockResolvedValue(makeBlog({ status: WebsiteBlogStatus.DRAFT }));

      await service.update('blog-1', { status: WebsiteBlogStatus.PUBLISHED } as never);

      expect(newsletterService.broadcast).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast for a status-less content edit', async () => {
      repo.findOne.mockResolvedValue(makeBlog({ status: WebsiteBlogStatus.PUBLISHED }));

      await service.update('blog-1', { title: 'Updated title' } as never);

      expect(newsletterService.broadcast).not.toHaveBeenCalled();
    });
  });
});
