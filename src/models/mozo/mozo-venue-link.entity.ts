import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** Maps a Mozo venue_id to the HexaAI company API key that services it (see /mozo/hexaai/connect). */
@Entity({ name: 'mozo_venue_links' })
export class MozoVenueLink {
  @PrimaryColumn({ name: 'venue_id', type: 'varchar', length: 255 })
  venueId: string;

  @Column({ name: 'api_key', type: 'text' })
  apiKey: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
