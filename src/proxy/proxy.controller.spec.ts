import { ConfigService } from '@nestjs/config';
import { ProxyController } from './proxy.controller.js';
import { EncryptionService } from '../encryption/encryption.service.js';
import { ProxyService } from './proxy.service.js';

describe('Response encryption configuration', () => {
  it.each([undefined, '', 'true', 'false'])('accepts %p', (value) => {
    expect(
      () =>
        new ProxyController(
          {} as EncryptionService,
          {} as ProxyService,
          { get: () => value } as unknown as ConfigService,
        ),
    ).not.toThrow();
  });

  it.each(['FALSE', '0', 'yes', 'flase'])(
    'rejects invalid configuration %p at startup',
    (value) => {
      expect(
        () =>
          new ProxyController(
            {} as EncryptionService,
            {} as ProxyService,
            { get: () => value } as unknown as ConfigService,
          ),
      ).toThrow('ENCRYPT_RESPONSE must be true or false');
    },
  );
});
