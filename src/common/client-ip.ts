import { isIP } from 'node:net';

/**
 * Groups IPv6 clients by /64 for rate limiting. A single host usually controls
 * a whole /64, so keying on the full address lets it rotate freely.
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const lower = ip.toLowerCase().split('%')[0];
  if (isIP(lower) !== 6) return lower;

  const groups = expandIpv6(lower);
  if (!groups) return lower;

  // IPv4-mapped addresses should share the bucket of the IPv4 address itself.
  if (
    groups.slice(0, 5).every((group) => group === '0') &&
    groups[5] === 'ffff'
  ) {
    const high = parseInt(groups[6], 16);
    const low = parseInt(groups[7], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }

  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

function expandIpv6(address: string): string[] | null {
  let value = address;
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':');
    if (colon === -1) return null;
    const ipv4 = value.slice(colon + 1);
    if (isIP(ipv4) !== 4) return null;
    const [a, b, c, d] = ipv4.split('.').map(Number);
    value = `${value.slice(0, colon)}:${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;

  if (halves.length === 1) {
    if (left.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }

  const groups = [
    ...left,
    ...Array<string>(Math.max(0, missing)).fill('0'),
    ...right,
  ];
  if (groups.length !== 8) return null;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups;
}
