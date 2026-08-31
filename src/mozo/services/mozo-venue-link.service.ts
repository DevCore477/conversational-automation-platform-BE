import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MozoVenueLink } from '../../models/mozo/mozo-venue-link.entity';

/** Durable (DB-backed) venue_id -> HexaAI API key mapping. Survives restarts, unlike the standalone bridge's in-memory Map. */
@Injectable()
export class MozoVenueLinkService {
  constructor(
    @InjectRepository(MozoVenueLink)
    private readonly repository: Repository<MozoVenueLink>,
  ) {}

  /** Upserts by venue_id — calling connect again for the same venue relinks it to the new key. */
  async link(venueId: string, apiKey: string): Promise<void> {
    await this.repository.save(this.repository.create({ venueId, apiKey }));
  }

  async findApiKeyForVenue(venueId: string): Promise<string | null> {
    const row = await this.repository.findOne({ where: { venueId } });
    return row?.apiKey ?? null;
  }
}
