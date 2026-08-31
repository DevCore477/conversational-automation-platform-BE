import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlogsController } from './blogs.controller';
import { BlogsService } from './blogs.service';
import { GuardsModule } from '../guards/guards.module';
import { Blog } from '../models/blogs/blog.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Blog]), GuardsModule],
  controllers: [BlogsController],
  providers: [BlogsService],
  exports: [BlogsService],
})
export class BlogsModule {}
