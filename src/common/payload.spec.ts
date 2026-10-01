import { parsePayload, normalizeRequestBody } from './payload.js';

const nestedBody = (depth: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
};

describe('Payload limits across supported formats', () => {
  it.each(['object', 'JSON string'])(
    'rejects excessive nesting in %s bodies',
    (format) => {
      const nested = nestedBody(33);
      const Body = format === 'object' ? nested : JSON.stringify(nested);
      expect(() =>
        parsePayload({ AccessPoint: 'https://api.example.com', Body }),
      ).toThrow(/32 levels/);
    },
  );

  it('accepts the nesting boundary and preserves raw text', () => {
    const body = nestedBody(32);
    expect(normalizeRequestBody(JSON.stringify(body))).toEqual(body);
    expect(normalizeRequestBody('plain text')).toBe('plain text');
  });

  it.each(['map', 'array map', 'Key/Value'])(
    'enforces header length limits for %s',
    (format) => {
      const header = (name: string, value: string) =>
        format === 'map'
          ? { [name]: value }
          : format === 'array map'
            ? [{ [name]: value }]
            : [{ Key: name, Value: value }];
      const payload = (name: string, value: string) => ({
        AccessPoint: 'https://api.example.com',
        Header: header(name, value),
      });
      expect(() =>
        parsePayload(payload('x'.repeat(256), 'v'.repeat(8192))),
      ).not.toThrow();
      expect(() => parsePayload(payload('x'.repeat(257), 'v'))).toThrow(
        /256 characters/,
      );
      expect(() => parsePayload(payload('X-Test', 'v'.repeat(8193)))).toThrow(
        /8192 characters/,
      );
    },
  );
});
