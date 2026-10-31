import { clientIpKey } from './client-ip.js';

describe('clientIpKey', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(clientIpKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by /64', () => {
    expect(clientIpKey('2001:db8:1:2::1')).toBe(
      clientIpKey('2001:db8:1:2:ffff::9'),
    );
    expect(clientIpKey('2001:db8:1:2::1')).not.toBe(
      clientIpKey('2001:db8:1:3::1'),
    );
  });

  it('handles compressed, expanded, and zoned addresses', () => {
    const expected = clientIpKey('2001:0db8:0001:0002:0000:0000:0000:0001');
    expect(clientIpKey('2001:db8:1:2::1')).toBe(expected);
    expect(clientIpKey('2001:db8:1:2::1%eth0')).toBe(expected);
  });

  it('falls back to a safe key when the address is missing', () => {
    expect(clientIpKey(undefined)).toBe('unknown');
  });
});
