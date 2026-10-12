import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Makes {@link PrismaService} available to every module. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
