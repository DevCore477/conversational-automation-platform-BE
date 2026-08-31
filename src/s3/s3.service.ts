import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class S3Service {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly prefix: string;
  private readonly logger = new Logger(S3Service.name);

  constructor(private configService: ConfigService) {
    const region = this.configService.get<string>('s3.region');
    const accessKeyId = this.configService.get<string>('s3.accessKeyId');
    const secretAccessKey = this.configService.get<string>('s3.secretAccessKey');
    this.bucketName = this.configService.get<string>('s3.bucketName') ?? '';

    // Debug logging (remove after fixing)
    this.logger.debug(`S3 Config - Region: ${region}, Bucket: ${this.bucketName}`);
    this.logger.debug(`AccessKey exists: ${!!accessKeyId}, SecretKey exists: ${!!secretAccessKey}`);

    // Validate config
    if (!this.bucketName || !region || !accessKeyId || !secretAccessKey) {
      throw new Error(
        `Missing S3 configuration. Check your environment variables:\n` +
          `S3_BUCKET_NAME: ${this.bucketName}\n` +
          `S3_REGION: ${region}\n` +
          `S3_ACCESS_KEY_ID: ${accessKeyId ? 'set' : 'missing'}\n` +
          `S3_SECRET_ACCESS_KEY: ${secretAccessKey ? 'set' : 'missing'}`,
      );
    }

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.bucketName = this.configService.get<string>('s3.bucketName') ?? '';
    this.prefix = this.configService.get<string>('s3.prefix', 'logo');
  }

  /**
   * Generate a presigned URL for direct upload to S3
   */
  async generatePresignedUrl(
    filename: string,
    contentType: string,
  ): Promise<{ uploadUrl: string; fileUrl: string; key: string }> {
    // Validate image content type
    if (!contentType.startsWith('image/')) {
      throw new Error('Only image files are allowed');
    }

    // Generate unique key with prefix
    const extension = filename.split('.').pop();
    const key = `${this.prefix}/${uuidv4()}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
      // Optional: Add metadata
      Metadata: {
        originalName: filename,
        uploadedAt: new Date().toISOString(),
      },
    });

    const expiresIn = this.configService.get<number>('PRESIGNED_URL_EXPIRATION', 300);
    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn });

    // Construct the public URL (adjust based on your bucket policy)
    const fileUrl = `https://${this.bucketName}.s3.${this.configService.get('AWS_REGION')}.amazonaws.com/${key}`;

    return { uploadUrl, fileUrl, key };
  }

  /**
   * NEW: Upload file buffer directly to S3
   */
  async uploadFile(
    buffer: Buffer,
    mimetype: string,
    originalName: string,
  ): Promise<{ fileUrl: string; key: string }> {
    if (!mimetype.startsWith('image/')) {
      throw new Error('Only image files are allowed');
    }

    const extension = originalName.split('.').pop();
    const key = `${this.prefix}/${uuidv4()}.${extension}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        Metadata: {
          originalName,
          uploadedAt: new Date().toISOString(),
        },
      }),
    );

    const region = this.configService.get<string>('s3.region');
    const fileUrl = `https://${this.bucketName}.s3.${region}.amazonaws.com/${key}`;

    return { fileUrl, key };
  }

  /**
   * Upload any supported media buffer (image/video/audio/documents) under a caller-provided
   * prefix. Kept separate from `uploadFile` (image-only) so existing callers/behavior are untouched.
   *
   * `bucket` optionally routes the upload to a different bucket than the shared `S3_BUCKET_NAME`
   * one (e.g. a dedicated WhatsApp media bucket) — same client/credentials/region, just a
   * different `Bucket` target, so no separate AWS SDK client is needed.
   */
  async uploadMedia(
    buffer: Buffer,
    mimetype: string,
    originalName: string,
    prefix: string,
    bucket?: string,
  ): Promise<{ fileUrl: string; key: string }> {
    if (!this.isSupportedMediaMimeType(mimetype)) {
      throw new BadRequestException(`Unsupported media type for upload: ${mimetype}`);
    }

    const targetBucket = bucket?.trim() ?? this.bucketName;
    const extension = originalName.split('.').pop() ?? 'bin';
    const key = `${prefix}/${uuidv4()}.${extension}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: targetBucket,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        Metadata: {
          originalName,
          uploadedAt: new Date().toISOString(),
        },
      }),
    );

    const region = this.configService.get<string>('s3.region');
    const fileUrl = `https://${targetBucket}.s3.${region}.amazonaws.com/${key}`;

    return { fileUrl, key };
  }

  private isSupportedMediaMimeType(mimetype: string): boolean {
    return (
      mimetype.startsWith('image/') ||
      mimetype.startsWith('video/') ||
      mimetype.startsWith('audio/') ||
      mimetype === 'application/pdf' ||
      mimetype === 'text/plain' ||
      mimetype.includes('officedocument') ||
      mimetype === 'application/msword' ||
      mimetype === 'application/vnd.ms-excel' ||
      mimetype === 'application/vnd.ms-powerpoint'
    );
  }

  /**
   * Delete a file from S3 by key, or by its full public URL.
   */
  async deleteFile(keyOrUrl: string): Promise<{ key: string }> {
    const key = this.resolveKey(keyOrUrl);

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    return { key };
  }

  private resolveKey(keyOrUrl: string): string {
    if (!keyOrUrl) {
      throw new BadRequestException('key or fileUrl is required');
    }

    if (!/^https?:\/\//i.test(keyOrUrl)) {
      return keyOrUrl.replace(/^\/+/, '');
    }

    try {
      const url = new URL(keyOrUrl);
      const key = url.pathname.replace(/^\/+/, '');

      if (!key) {
        throw new BadRequestException('Could not extract S3 key from fileUrl');
      }

      return key;
    } catch {
      throw new BadRequestException('Invalid fileUrl');
    }
  }
}
