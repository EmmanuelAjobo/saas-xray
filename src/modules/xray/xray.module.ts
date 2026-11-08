import { Module } from '@nestjs/common';
import { XrayController } from './xray.controller.js';
import { XrayReaderService } from './xray-reader.service.js';

/** The X-ray's endpoints. The plumbing that feeds them is `core/xray`. */
@Module({
  controllers: [XrayController],
  providers: [XrayReaderService],
})
export class XrayModule {}
