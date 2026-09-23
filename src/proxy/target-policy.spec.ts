import { BadRequestException } from '@nestjs/common';
import { TargetPolicy } from './target-policy.js';

const allowed = (policy: TargetPolicy, method: string, url: string) => {
  try {
    policy.assertAllowed(method, new URL(url));
    return true;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return false;
  }
};

describe('TargetPolicy', () => {
  it('rejects everything when both lists are empty', () => {
    const policy = new TargetPolicy('', '');
    expect(policy.isEmpty).toBe(true);
    expect(allowed(policy, 'GET', 'https://api.example.com/')).toBe(false);
  });

  describe('ALLOWED_TARGET_HOSTS', () => {
    const policy = new TargetPolicy('api.example.com, API2.example.com:8443');

    it.each([
      ['GET', 'https://api.example.com/anything/at/all', true],
      ['DELETE', 'https://api.example.com:443/x', true],
      ['GET', 'https://api2.example.com:8443/x', true],
      ['GET', 'https://api.example.com:5432/', false],
      ['GET', 'https://api2.example.com/x', false],
      ['GET', 'https://evil.com/', false],
    ])('%s %s → %s', (method, url, expected) => {
      expect(allowed(policy, method, url)).toBe(expected);
    });

    it('treats an explicit default port like no port', () => {
      const withPort = new TargetPolicy('api.example.com:443');
      expect(allowed(withPort, 'GET', 'https://api.example.com/x')).toBe(true);
    });
  });

  describe('ALLOWED_ROUTES', () => {
    const policy = new TargetPolicy(
      '',
      [
        'POST api.example.com/api/login',
        'get api.example.com/api/products/*',
        'api.example.com/public/*',
        'PUT api.example.com:8443/v1/items/*',
      ].join(','),
    );

    it.each([
      // exact path + method
      ['POST', 'https://api.example.com/api/login', true],
      ['POST', 'https://api.example.com/api/login?x=1', true],
      ['GET', 'https://api.example.com/api/login', false],
      ['POST', 'https://api.example.com/api/login/extra', false],
      // prefix
      ['GET', 'https://api.example.com/api/products/1', true],
      ['GET', 'https://api.example.com/api/products/1/reviews', true],
      ['GET', 'https://api.example.com/api/products', false],
      ['POST', 'https://api.example.com/api/products/1', false],
      // any method
      ['DELETE', 'https://api.example.com/public/x', true],
      // port-specific
      ['PUT', 'https://api.example.com:8443/v1/items/9', true],
      ['PUT', 'https://api.example.com/v1/items/9', false],
      // not listed
      ['GET', 'https://api.example.com/admin', false],
    ])('%s %s → %s', (method, url, expected) => {
      expect(allowed(policy, method, url)).toBe(expected);
    });

    it('is not fooled by dot segments', () => {
      // URL parsing resolves these to /admin before matching
      expect(
        allowed(policy, 'GET', 'https://api.example.com/public/../admin'),
      ).toBe(false);
      expect(
        allowed(policy, 'GET', 'https://api.example.com/public/%2e%2e/admin'),
      ).toBe(false);
    });

    it('rejects encoded slashes that upstreams may decode', () => {
      expect(
        allowed(policy, 'GET', 'https://api.example.com/public/..%2Fadmin'),
      ).toBe(false);
      expect(
        allowed(policy, 'GET', 'https://api.example.com/public/a%5cb'),
      ).toBe(false);
    });
  });

  it('allows a request that matches either list', () => {
    const policy = new TargetPolicy(
      'cdn.example.com',
      'GET api.example.com/api/*',
    );
    expect(allowed(policy, 'POST', 'https://cdn.example.com/x')).toBe(true);
    expect(allowed(policy, 'GET', 'https://api.example.com/api/x')).toBe(true);
    expect(allowed(policy, 'POST', 'https://api.example.com/api/x')).toBe(
      false,
    );
  });

  it.each([
    ['https://api.example.com', '', /remove the scheme/],
    ['api.example.com/api', '', /put paths in ALLOWED_ROUTES/],
    ['api example.com', '', /expected host/],
    ['', 'https://api.example.com/x', /remove the scheme/],
    ['', 'api.example.com', /expected host\/path/],
    ['', 'TRACE api.example.com/x', /method must be one of/],
    ['', 'GET api.example.com/a/*/b', /only allowed at the end/],
    ['', 'GET api.example.com/x extra', /expected "\[METHOD\] host\/path"/],
  ])('fails fast on bad config: hosts=%p routes=%p', (hosts, routes, error) => {
    expect(() => new TargetPolicy(hosts, routes)).toThrow(error);
  });
});
