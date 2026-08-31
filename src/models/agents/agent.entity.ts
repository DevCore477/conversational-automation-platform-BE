import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '../companies/company.entity';
import type { ResponseEngine } from '../../agents/types/response-engine.types';
import type { ConversationFlowMode } from '../../agents/types/conversation-flow-mode.types';

export type AgentChannel = 'voice';

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'companyId' })
  company?: Company;

  @Column({ type: 'varchar', length: 255 })
  agentName: string;

  /**
   * Free-form instructions for the AI for every turn (persona, tone, facts).
   * Injected into script and conversation-flow LLM calls when a call uses this agent.
   */
  @Column({ type: 'text', nullable: true })
  globalPrompt: string | null;

  @Column({ type: 'varchar', length: 50, default: 'voice' })
  channel: AgentChannel;

  /** How the agent responds: conversation-flow | script | llm */
  @Column({ type: 'jsonb' })
  responseEngine: ResponseEngine;

  /**
   * When responseEngine is conversation-flow: strict node-by-node behavior vs flexible flow-wide context.
   * Ignored for script/llm engines. Default rigid.
   */
  @Column({ type: 'varchar', length: 20, default: 'rigid' })
  conversationFlowMode: ConversationFlowMode;

  @Column({ type: 'varchar', length: 20, default: 'en-US' })
  language: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  voiceId: string | null;

  @Column({ type: 'int', default: 3600000 })
  maxCallDurationMs: number;

  @Column({ type: 'float', default: 0.9 })
  interruptionSensitivity: number;

  @Column({ type: 'varchar', length: 50, default: 'everything' })
  dataStorageSetting: string;

  /** Optional DTMF / keypress options (e.g. "press 1 for X") */
  @Column({ type: 'jsonb', nullable: true })
  userDtmfOptions: Record<string, unknown> | null;

  @Column({ type: 'int', default: 0 })
  version: number;

  @Column({ type: 'boolean', default: false })
  isPublished: boolean;

  /** Optional: post-call analysis model (e.g. gpt-4.1-mini) */
  @Column({ type: 'varchar', length: 80, nullable: true })
  postCallAnalysisModel: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
