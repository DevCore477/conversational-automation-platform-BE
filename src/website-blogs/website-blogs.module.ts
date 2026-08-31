import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminWebsiteBlogsController } from './admin-website-blogs.controller';
import { WebsiteBlogsController } from './website-blogs.controller';
import { WebsiteBlogsService } from './website-blogs.service';
import { GuardsModule } from '../guards/guards.module';
import { WebsiteBlog } from '../models/website-blogs/website-blog.entity';
import { NewsletterModule } from '../newsletter/newsletter.module';

@Module({
  imports: [TypeOrmModule.forFeature([WebsiteBlog]), GuardsModule, NewsletterModule],
  controllers: [WebsiteBlogsController, AdminWebsiteBlogsController],
  providers: [WebsiteBlogsService],
  exports: [WebsiteBlogsService],
})
export class WebsiteBlogsModule {}
