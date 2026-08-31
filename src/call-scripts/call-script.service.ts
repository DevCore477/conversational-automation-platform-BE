import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import type { CreateCallScriptInput } from './dto/create-call-script.dto';
import { UpdateCallScriptDto } from './dto/update-call-script.dto';
import { CallScript } from '../models/call-scripts/call-script.entity';

@Injectable()
export class CallScriptService {
  private readonly logger = new Logger(CallScriptService.name);

  constructor(
    @InjectRepository(CallScript)
    private readonly callScriptRepository: Repository<CallScript>,
  ) {}

  /**
   * Create a new call script
   */
  async create(dto: CreateCallScriptInput): Promise<CallScript> {
    // Check if name already exists
    const existing = await this.callScriptRepository.findOne({
      where: { name: dto.name, companyId: dto.companyId },
    });
    console.log(existing);
    if (existing) {
      throw new ConflictException(`A script with name "${dto.name}" already exists`);
    }

    // If this is set as default, unset other defaults
    if (dto.isDefault) {
      await this.unsetAllDefaults();
    }

    const script = this.callScriptRepository.create(dto);
    const saved = await this.callScriptRepository.save(script);

    this.logger.log(`Created call script: ${saved.name} (${saved.id})`);

    return saved;
  }

  /**
   * Get all call scripts
   */
  async findAll(companyId?: string): Promise<CallScript[]> {
    if (companyId) {
      return this.callScriptRepository.find({
        where: { companyId },
        order: {
          isDefault: 'DESC',
          isActive: 'DESC',
          createdAt: 'DESC',
        },
      });
    } else {
      return this.callScriptRepository.find({
        order: {
          isDefault: 'DESC',
          isActive: 'DESC',
          createdAt: 'DESC',
        },
      });
    }
  }

  /**
   * Get all active call scripts, optionally filtered created within a certain period (e.g. last 24 hours)
   */
  async findAllSince(since: Date, companyId?: string): Promise<CallScript[]> {
    if (companyId) {
      return this.callScriptRepository.find({
        where: {
          companyId,
          createdAt: Between(since, new Date()),
        },
        order: {
          isActive: 'DESC',
          isDefault: 'DESC',
          createdAt: 'DESC',
        },
      });
    } else {
      return this.callScriptRepository.find({
        where: {
          createdAt: Between(since, new Date()),
        },
        order: {
          isActive: 'DESC',
          isDefault: 'DESC',
          createdAt: 'DESC',
        },
      });
    }
  }

  /**
   * Get All call scripts by company
   */
  async findAllByCompany(companyId: string): Promise<CallScript[]> {
    return this.callScriptRepository.find({
      where: { companyId },
      order: {
        isDefault: 'DESC',
        isActive: 'DESC',
        createdAt: 'DESC',
      },
    });
  }

  /**
   * Get active call scripts only
   */
  async findAllActive(): Promise<CallScript[]> {
    return this.callScriptRepository.find({
      where: { isActive: true },
      order: {
        isDefault: 'DESC',
        createdAt: 'DESC',
      },
    });
  }

  /**
   * Get a single call script by ID
   */
  async findOne(id: string): Promise<CallScript> {
    const script = await this.callScriptRepository.findOne({
      where: { id },
    });

    if (!script) {
      throw new NotFoundException(`Call script with ID "${id}" not found`);
    }

    return script;
  }

  async getOneScript(id: string) {
    try {
      const script = await this.callScriptRepository.findOne({
        where: { id },
      });
      if (script) return script;
      else return null;
    } catch (e) {
      this.logger.error(e?.message ?? e);
    }
  }

  /**
   * Get an active call script by name (e.g. for vet clinic Norwegian routing).
   */
  async findByName(name: string): Promise<CallScript | null> {
    return this.callScriptRepository.findOne({
      where: { name, isActive: true },
    });
  }

  /**
   * Get the default call script
   */
  async findDefault(): Promise<CallScript | null> {
    return await this.callScriptRepository.findOne({
      where: { isDefault: true, isActive: true },
    });
  }

  /**
   * Get the default call script for a specific call type
   */
  async findDefaultByType(callType: 'inbound' | 'outbound'): Promise<CallScript | null> {
    return await this.callScriptRepository.findOne({
      where: {
        isDefault: true,
        isActive: true,
        callType: In([callType, 'both']),
      },
    });
  }

  /**
   * Get the default inbound script for a company.
   * Used when routing inbound calls by called number: match company → load its script.
   */
  async findDefaultInboundByCompany(companyId: string): Promise<CallScript | null> {
    return await this.callScriptRepository.findOne({
      where: {
        companyId,
        isActive: true,
        callType: In(['inbound', 'both']),
      },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });
  }

  /**
   * Get all scripts for a specific call type
   */
  async findByCallType(callType: 'inbound' | 'outbound'): Promise<CallScript[]> {
    return this.callScriptRepository.find({
      where: {
        callType: In([callType, 'both']),
        isActive: true,
      },
      order: {
        isDefault: 'DESC',
        totalCalls: 'DESC',
        createdAt: 'DESC',
      },
    });
  }

  /**
   * Get the default call script or throw error
   */
  async getDefaultOrThrow(): Promise<CallScript> {
    const script = await this.findDefault();

    if (!script) {
      throw new NotFoundException('No default call script found. Please set a default script.');
    }

    return script;
  }

  /**
   * Update a call script
   */
  async update(
    id: string,
    dto: UpdateCallScriptDto,
    userCompany: string | undefined,
  ): Promise<CallScript> {
    const script = await this.findOne(id);

    // Check if name is being changed and if it conflicts
    if (dto.name && dto.name !== script.name) {
      const existing = await this.callScriptRepository.findOne({
        where: { name: dto.name, companyId: userCompany },
      });
      console.log(existing);
      if (existing) {
        throw new ConflictException(`A script with name "${dto.name}" already exists`);
      }
    }

    // If setting as default, unset other defaults
    if (dto.isDefault === true) {
      await this.unsetAllDefaults();
    }

    Object.assign(script, dto);
    const updated = await this.callScriptRepository.save(script);

    this.logger.log(`Updated call script: ${updated.name} (${updated.id})`);

    return updated;
  }

  /**
   * Set a script as the default
   */
  async setDefault(id: string): Promise<CallScript> {
    const script = await this.findOne(id);

    if (!script.isActive) {
      throw new BadRequestException(
        'Cannot set an inactive script as default. Please activate it first.',
      );
    }

    await this.unsetAllDefaults();

    script.isDefault = true;
    const updated = await this.callScriptRepository.save(script);

    this.logger.log(`Set default call script: ${updated.name} (${updated.id})`);

    return updated;
  }

  /**
   * Delete a call script
   */
  async delete(id: string): Promise<void> {
    const script = await this.findOne(id);

    if (script.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default script. Please set another script as default first.',
      );
    }

    await this.callScriptRepository.remove(script);

    this.logger.log(`Deleted call script: ${script.name} (${id})`);
  }

  /**
   * Toggle active status
   */
  async toggleActive(id: string): Promise<CallScript> {
    const script = await this.findOne(id);

    if (script.isDefault && script.isActive) {
      throw new BadRequestException(
        'Cannot deactivate the default script. Please set another script as default first.',
      );
    }

    script.isActive = !script.isActive;
    const updated = await this.callScriptRepository.save(script);

    this.logger.log(
      `Toggled active status for script: ${updated.name} (${updated.id}) - Now ${updated.isActive ? 'active' : 'inactive'}`,
    );

    return updated;
  }

  /**
   * Unset all default flags
   */
  private async unsetAllDefaults(): Promise<void> {
    await this.callScriptRepository.update({ isDefault: true }, { isDefault: false });
  }

  /**
   * Get statistics (By company if provided)
   */
  async getStats(
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    total: number;
    active: number;
    inactive: number;
    hasDefault: boolean;
    byCallType: {
      inbound: number;
      outbound: number;
      both: number;
    };
    byStatus: {
      completed: number;
      failed: number;
      active: number;
      initiating: number;
    };
    totalCallsMade: number;
    mostUsedScript: { name: string; calls: number } | null;
  }> {
    let all: CallScript[];
    if (period) {
      const now = new Date();
      const periodMs = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
      if (companyId) {
        all = await this.callScriptRepository.find({
          where: {
            companyId,
            isActive: true,
            createdAt: Between(cutoff, now),
          },
        });
      } else {
        all = await this.callScriptRepository.find({
          where: {
            isActive: true,
            createdAt: Between(cutoff, now),
          },
        });
      }
    } else {
      if (companyId) {
        all = await this.callScriptRepository.find({
          where: { companyId, isActive: true },
        });
      } else {
        all = await this.callScriptRepository.find({
          where: { isActive: true },
        });
      }
    }
    // if (companyId) {
    //   all = await this.callScriptRepository.find({
    //     where: { companyId, isActive: true },
    //   });
    // } else {
    //   all = await this.callScriptRepository.find({
    //     where: { isActive: true },
    //   });
    // }
    const defaultScript = await this.findDefault();

    // Find most used script
    const mostUsed = all.reduce<{ name: string; calls: number } | null>((max, script) => {
      return script.totalCalls > (max?.calls ?? 0)
        ? { name: script.name, calls: script.totalCalls }
        : max;
    }, null);

    return {
      total: all.length,
      active: all.filter(s => s.isActive).length,
      inactive: all.filter(s => !s.isActive).length,
      hasDefault: !!defaultScript,
      byCallType: {
        inbound: all.filter(s => s.callType === 'inbound').length,
        outbound: all.filter(s => s.callType === 'outbound').length,
        both: all.filter(s => s.callType === 'both').length,
      },
      byStatus: {
        completed: all.reduce((sum, s) => sum + s.successfulCalls, 0),
        failed: all.reduce((sum, s) => sum + s.failedCalls, 0),
        active: 0, // Placeholder - implement if tracking active calls per script
        initiating: 0, // Placeholder - implement if tracking initiating calls per script
      },
      totalCallsMade: all.reduce((sum, s) => sum + s.totalCalls, 0),
      mostUsedScript: mostUsed,
    };
  }

  /**
   * Track script usage when a call is made
   */
  async trackUsage(scriptId: string, success = true): Promise<void> {
    try {
      const script = await this.findOne(scriptId);

      script.totalCalls += 1;
      if (success) {
        script.successfulCalls += 1;
      } else {
        script.failedCalls += 1;
      }
      script.lastUsedAt = new Date();

      await this.callScriptRepository.save(script);

      this.logger.log(
        `Tracked usage for script: ${script.name} (${scriptId}) - Total: ${String(script.totalCalls)}`,
      );
    } catch (error) {
      this.logger.error(`Failed to track usage for script ${scriptId}:`, error);
      // Don't throw error - usage tracking should not break the call flow
    }
  }

  /**
   * Get script statistics by ID
   */
  async getScriptStats(id: string): Promise<{
    id: string;
    name: string;
    callType: 'inbound' | 'outbound' | 'both';
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    successRate: number;
    lastUsedAt: Date | null;
    isActive: boolean;
    isDefault: boolean;
  }> {
    const script = await this.findOne(id);

    const successRate =
      script.totalCalls > 0 ? (script.successfulCalls / script.totalCalls) * 100 : 0;

    return {
      id: script.id,
      name: script.name,
      callType: script.callType,
      totalCalls: script.totalCalls,
      successfulCalls: script.successfulCalls,
      failedCalls: script.failedCalls,
      successRate: Math.round(successRate * 100) / 100,
      lastUsedAt: script.lastUsedAt,
      isActive: script.isActive,
      isDefault: script.isDefault,
    };
  }
}
