import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConnectUsSubmission } from '../models/connect-us/connect-us.entity';
import { CreateConnectUsDto } from './dto/create-connect-us.dto';

@Injectable()
export class ConnectUsService {
  constructor(
    @InjectRepository(ConnectUsSubmission)
    private readonly connectUsRepository: Repository<ConnectUsSubmission>,
  ) {}

  async create(dto: CreateConnectUsDto): Promise<ConnectUsSubmission> {
    const submission = this.connectUsRepository.create({
      ...dto,
      createdAt: new Date(),
    });
    return this.connectUsRepository.save(submission);
  }

  async findAll(): Promise<ConnectUsSubmission[]> {
    return this.connectUsRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<ConnectUsSubmission | null> {
    return this.connectUsRepository.findOne({ where: { id } });
  }

  async update(id: string, dto: { status: string }): Promise<ConnectUsSubmission | null> {
    const submission = await this.connectUsRepository.findOne({ where: { id } });
    if (!submission) {
      return null;
    }
    Object.assign(submission, dto);
    return this.connectUsRepository.save(submission);
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.connectUsRepository.delete(id);
      return true;
    } catch (error) {
      console.error(`Failed to delete submission with id ${id}:`, error);
      return false;
    }
  }
}
