import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';

import { mergeApiKeyPermissionsForSave } from './api-key-permissions.util';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { ApiKey } from '../models/companies/api-key.entity';
import { Company } from '../models/companies/company.entity';

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  /**
   * Generate a new API key
   */
  async create(data: {
    companyId: string;
    name: string;
    description?: string;
    permissions?: ApiKey['permissions'];
    restrictions?: ApiKey['restrictions'];
    expiresAt?: Date;
    createdBy: string;
  }): Promise<{ apiKey: ApiKey; plainKey: string }> {
    // Verify company exists
    const company = await this.companyRepository.findOne({
      where: { id: data.companyId },
    });

    if (!company) {
      throw new NotFoundException(`Company with ID "${data.companyId}" not found`);
    }

    // Generate random API key
    const plainKey = this.generateApiKey();
    const hashedKey = this.hashApiKey(plainKey);
    const keyPrefix = plainKey.substring(0, 16); // First 16 chars for display

    // Create API key record
    const apiKey = this.apiKeyRepository.create({
      companyId: data.companyId,
      name: data.name,
      key: hashedKey,
      keyPrefix,
      description: data.description,
      permissions: mergeApiKeyPermissionsForSave(data.permissions),
      restrictions: data.restrictions,
      expiresAt: data.expiresAt,
      createdBy: data.createdBy,
      isActive: true,
    });

    const saved = await this.apiKeyRepository.save(apiKey);

    this.logger.log(`Created API key "${saved.name}" for company ${data.companyId}`);

    // Return both the saved record and the plain key (only time we show it)
    return {
      apiKey: saved,
      plainKey, // IMPORTANT: Only returned once during creation!
    };
  }

  /**
   * Validate an API key and return company info
   */
  async validate(
    plainKey: string,
    ipAddress?: string,
  ): Promise<{
    isValid: boolean;
    company?: Company;
    apiKey?: ApiKey;
    error?: string;
  }> {
    try {
      const hashedKey = this.hashApiKey(plainKey);

      const apiKey = await this.apiKeyRepository.findOne({
        where: { key: hashedKey, isActive: true },
        relations: ['company'],
      });

      if (!apiKey) {
        return { isValid: false, error: 'Invalid API key' };
      }

      // Check if expired
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return { isValid: false, error: 'API key has expired' };
      }

      // Check if company is active
      if (!apiKey.company.isActive) {
        return { isValid: false, error: 'Company account is inactive' };
      }

      // Check IP whitelist if configured
      const whitelist = apiKey.restrictions?.ipWhitelist;
      if (whitelist != null && whitelist.length > 0) {
        if (ipAddress == null || !whitelist.includes(ipAddress)) {
          this.logger.warn(
            `IP ${ipAddress ?? 'invalid ip'} not in whitelist for API key ${apiKey.keyPrefix}`,
          );
          return { isValid: false, error: 'IP address not whitelisted' };
        }
      }

      // Update usage tracking
      await this.trackUsage(apiKey.id, ipAddress);

      return {
        isValid: true,
        company: apiKey.company,
        apiKey,
      };
    } catch (error: unknown) {
      this.logger.error(
        'Error validating API key:',
        error instanceof Error ? error.message : error,
      );
      return { isValid: false, error: 'Validation error' };
    }
  }

  /**
   * Get all API keys for a company
   */
  async findByCompany(companyId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get single API key by ID
   */
  async findOne(id: string, companyId: string): Promise<ApiKey> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id, companyId },
    });

    if (!apiKey) {
      throw new NotFoundException(`API key with ID "${id}" not found`);
    }

    return apiKey;
  }

  /**
   * Update API key
   */
  async update(id: string, companyId: string, data: UpdateApiKeyDto): Promise<ApiKey> {
    const apiKey = await this.findOne(id, companyId);

    const { expiresAt, isActive, permissions, ...rest } = data;
    Object.assign(apiKey, rest);
    if (permissions !== undefined) {
      apiKey.permissions = mergeApiKeyPermissionsForSave(permissions as ApiKey['permissions']);
    }
    if (expiresAt !== undefined) {
      apiKey.expiresAt = new Date(expiresAt);
    }
    if (isActive !== undefined) {
      apiKey.isActive = isActive;
    }

    const updated = await this.apiKeyRepository.save(apiKey);

    this.logger.log(`Updated API key: ${updated.name} (${updated.id})`);

    return updated;
  }

  /**
   * Delete an API key permanently
   */
  async delete(id: string, companyId: string): Promise<void> {
    const apiKey = await this.findOne(id, companyId);

    await this.apiKeyRepository.remove(apiKey);

    this.logger.log(`Deleted API key: ${apiKey.name} (${id})`);
  }

  /**
   * Track API key usage
   */
  private async trackUsage(apiKeyId: string, ipAddress?: string): Promise<void> {
    await this.apiKeyRepository.increment({ id: apiKeyId }, 'totalRequests', 1);

    await this.apiKeyRepository.update(apiKeyId, {
      lastUsedAt: new Date(),
      lastUsedIp: ipAddress ?? undefined,
    });
  }

  /**
   * Generate a random API key
   */
  private generateApiKey(): string {
    const randomBytes = crypto.randomBytes(32);
    return `sk_live_${randomBytes.toString('hex')}`;
  }

  /**
   * Hash an API key for storage
   */
  private hashApiKey(plainKey: string): string {
    return crypto.createHash('sha256').update(plainKey).digest('hex');
  }

  /**
   * Get API key statistics
   */
  async getStats(companyId: string): Promise<{
    total: number;
    active: number;
    inactive: number;
    totalRequests: number;
  }> {
    const keys = await this.findByCompany(companyId);

    const totalRequests = keys.reduce((sum, key) => sum + key.totalRequests, 0);

    return {
      total: keys.length,
      active: keys.filter(k => k.isActive).length,
      inactive: keys.filter(k => !k.isActive).length,
      totalRequests,
    };
  }
}
