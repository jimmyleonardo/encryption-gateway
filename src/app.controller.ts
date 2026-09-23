import { Controller, Get } from '@nestjs/common';
import { SkipRateLimit } from './common/rate-limit.guard.js';

@Controller()
export class AppController {
  @Get('health')
  @SkipRateLimit()
  health() {
    return { status: 'ok' };
  }
}
