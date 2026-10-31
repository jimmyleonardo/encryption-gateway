import { ConfigService } from '@nestjs/config';
import { ProxyController } from './proxy.controller.js';
import { EncryptionService } from '../encryption/encryption.service.js';
import { ProxyService } from './proxy.service.js';
import { ReplayProtectionService } from '../common/replay-protection.service.js';

describe('Response encryption configuration', () => {
  const make = (value: string | undefined) =>
    new ProxyController(
      {} as EncryptionService,
      {} as ProxyService,
      {} as ReplayProtectionService,
      { get: () => value } as unknown as ConfigService,
    );

  it.each([undefined, '', 'true', 'false'])('accepts %p', (value) => {
    expect(() => make(value)).not.toThrow();
  });

  it.each(['FALSE', '0', 'yes', 'flase'])(
    'rejects invalid configuration %p at startup',
    (value) => {
      expect(() => make(value)).toThrow(
        'ENCRYPT_RESPONSE must be true or false',
      );
    },
  );
});
