import { ApiProperty } from '@nestjs/swagger';

export class OutboxMessageDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Epoch milliseconds.' }) ts!: number;
  @ApiProperty({ example: 'billing@brightside-bakery.example' }) to!: string;
  @ApiProperty({ example: 'Invoice INV-0009 from Acme Studio' })
  subject!: string;
  @ApiProperty({ description: 'Plain text. Show it as text, never as HTML.' })
  text!: string;
}

export class OutboxDto {
  @ApiProperty({ type: [OutboxMessageDto], description: 'Newest first.' })
  data!: OutboxMessageDto[];
}
