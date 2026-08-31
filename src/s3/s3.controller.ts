import {
  Controller,
  Post,
  Delete,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBody, ApiConsumes } from '@nestjs/swagger';

import { S3Service } from './s3.service';

export class GeneratePresignedUrlDto {
  filename: string;
  contentType: string;
}

export class PresignedUrlResponse {
  uploadUrl: string;
  fileUrl: string;
  key: string;
}

export class DeleteImageDto {
  /** S3 object key (e.g. "logo/uuid.png") */
  key?: string;
  /** Full public S3 URL, used if key is not provided */
  fileUrl?: string;
}

@Controller('upload')
@ApiTags('Upload')
export class S3Controller {
  constructor(private readonly s3Service: S3Service) {}

  // ========== EXISTING: Presigned URL endpoint ==========
  @Post('presigned-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for image upload to S3' })
  @ApiBody({ type: GeneratePresignedUrlDto })
  async getPresignedUrl(@Body() dto: GeneratePresignedUrlDto): Promise<PresignedUrlResponse> {
    const { uploadUrl, fileUrl, key } = await this.s3Service.generatePresignedUrl(
      dto.filename,
      dto.contentType,
    );

    return { uploadUrl, fileUrl, key };
  }

  // ========== NEW: Direct image upload endpoint ==========
  @Post('image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file')) // 'file' is the form field name
  @ApiOperation({ summary: 'Upload image directly to S3 (max 5MB)' })
  @ApiConsumes('multipart/form-data') // Tells Swagger this accepts file uploads
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary', // Indicates file upload in Swagger UI
          description: 'Image file (jpg, jpeg, png, gif, webp)',
        },
      },
    },
  })
  async uploadImage(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5MB limit
          new FileTypeValidator({ fileType: /(jpg|jpeg|png|gif|webp)$/ }),
        ],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
  ) {
    // Upload the buffer directly to S3
    const result = await this.s3Service.uploadFile(file.buffer, file.mimetype, file.originalname);

    return {
      message: 'Image uploaded successfully',
      fileUrl: result.fileUrl,
      key: result.key,
    };
  }

  // ========== NEW: Delete image endpoint ==========
  @Delete('image')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an image from S3 by key or fileUrl' })
  @ApiBody({ type: DeleteImageDto })
  async deleteImage(@Body() dto: DeleteImageDto) {
    const keyOrUrl = dto.key ?? dto.fileUrl;

    if (!keyOrUrl) {
      throw new BadRequestException('Either "key" or "fileUrl" must be provided');
    }

    const result = await this.s3Service.deleteFile(keyOrUrl);

    return {
      message: 'Image deleted successfully',
      key: result.key,
    };
  }
}
