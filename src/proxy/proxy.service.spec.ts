import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { jest } from '@jest/globals';
import { of, throwError } from 'rxjs';
import { ProxyService } from './proxy.service.js';

describe('ProxyService', () => {
  let request: jest.Mock;

  const makeService = (env: Record<string, string>) => {
    request = jest.fn(() =>
      of({
        status: 200,
        data: { ok: true },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const http = { request } as unknown as HttpService;
    const config = {
      get: (k: string) => env[k],
    } as unknown as ConfigService;
    return new ProxyService(http, config);
  };

  const sentConfig = () => (request.mock.calls as AxiosRequestConfig[][])[0][0];

  const service = () =>
    makeService({ ALLOWED_TARGET_HOSTS: 'api.example.com, API2.example.com' });

  it('forwards to a whitelisted https host without following redirects', async () => {
    const res = await service().forward({
      AccessPoint: 'https://api.example.com/profile',
      Method: 'post',
      Body: '{"id":1}',
    });

    expect(res).toEqual({
      status: 200,
      data: { ok: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(sentConfig()).toMatchObject({
      url: 'https://api.example.com/profile',
      method: 'POST',
      data: { id: 1 },
      maxRedirects: 0,
    });
  });

  it('matches whitelist case-insensitively', async () => {
    await expect(
      service().forward({ AccessPoint: 'https://Api2.Example.com/x' }),
    ).resolves.toBeDefined();
  });

  it('rejects hosts outside the whitelist', async () => {
    await expect(
      service().forward({ AccessPoint: 'https://169.254.169.254/' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(request).not.toHaveBeenCalled();
  });

  it('only allows the default port unless a port is whitelisted', async () => {
    await expect(
      service().forward({ AccessPoint: 'https://api.example.com:443/x' }),
    ).resolves.toBeDefined();
    await expect(
      service().forward({ AccessPoint: 'https://api.example.com:5432/' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const withPort = makeService({
      ALLOWED_TARGET_HOSTS: 'api.example.com:8443',
    });
    await expect(
      withPort.forward({ AccessPoint: 'https://api.example.com:8443/x' }),
    ).resolves.toBeDefined();
    await expect(
      withPort.forward({ AccessPoint: 'https://api.example.com/x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['CR/LF in a value', { 'X-A': 'a\r\nInjected: 1' }],
    ['a space in a name', { 'Bad Name': 'v' }],
    ['an empty name', [{ Key: '', Value: 'v' }]],
  ])('rejects headers with %s', async (_label, Header) => {
    await expect(
      service().forward({ AccessPoint: 'https://api.example.com/', Header }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects everything when the whitelist is empty', async () => {
    await expect(
      makeService({}).forward({ AccessPoint: 'https://api.example.com/' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects http unless ALLOW_HTTP_UPSTREAM=true', async () => {
    const payload = { AccessPoint: 'http://api.example.com/' };
    await expect(service().forward(payload)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const lenient = makeService({
      ALLOWED_TARGET_HOSTS: 'api.example.com',
      ALLOW_HTTP_UPSTREAM: 'true',
    });
    await expect(lenient.forward(payload)).resolves.toBeDefined();
  });

  it('rejects unknown HTTP methods', async () => {
    await expect(
      service().forward({
        AccessPoint: 'https://api.example.com/',
        Method: 'TRACE',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalizes headers and drops hop-by-hop / Host headers', async () => {
    await service().forward({
      AccessPoint: 'https://api.example.com/',
      Header: [
        { Key: 'Authorization', Value: 'Bearer t' },
        { 'X-App': 'demo', Host: 'evil.internal' },
        { Key: 'Content-Length', Value: '999' },
      ],
    });

    expect(sentConfig().headers).toEqual({
      Authorization: 'Bearer t',
      'X-App': 'demo',
    });
  });

  it('sends Parameter as query and no body for GET', async () => {
    await service().forward({
      AccessPoint: 'https://api.example.com/',
      Method: 'GET',
      Body: '{"ignored":true}',
      Parameter: '{"page":2}',
    });

    expect(sentConfig().params).toEqual({ page: 2 });
    expect(sentConfig().data).toBeUndefined();
  });

  it('maps transport failures to 502 without leaking details', async () => {
    const svc = service();
    request.mockReturnValueOnce(
      throwError(() => new AxiosError('connect ECONNREFUSED 10.0.0.5:443')),
    );

    await expect(
      svc.forward({ AccessPoint: 'https://api.example.com/' }),
    ).rejects.toThrow(new BadGatewayException('Failed to reach upstream API'));
  });

  it('preserves the DELETE body', async () => {
    await service().forward({
      AccessPoint: 'https://api.example.com/items',
      Method: 'DELETE',
      Body: { ids: [1, 2] },
    });
    expect(sentConfig().data).toEqual({ ids: [1, 2] });
  });

  it('drops forged proxy identity and Connection-nominated headers in any order', async () => {
    await service().forward({
      AccessPoint: 'https://api.example.com/',
      Header: [
        { 'X-Internal': 'secret', Authorization: 'Bearer token' },
        { Key: 'Connection', Value: 'X-Internal, x-extra' },
        { 'X-Extra': 'secret', Forwarded: 'for=127.0.0.1' },
        { 'x-FoRwArDeD-For': '127.0.0.1', 'X-Forwarded-Host': 'internal' },
        { 'X-Real-IP': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1' },
        { 'True-Client-IP': '127.0.0.1', 'Fastly-Client-IP': '127.0.0.1' },
      ],
    });
    expect(sentConfig().headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('applies the configured response size limit', async () => {
    await makeService({
      ALLOWED_TARGET_HOSTS: 'api.example.com',
      MAX_UPSTREAM_RESPONSE_BYTES: '1024',
    }).forward({ AccessPoint: 'https://api.example.com/' });
    expect(sentConfig().maxContentLength).toBe(1024);
  });

  it('falls back to the default limit when the variable is empty', async () => {
    await makeService({
      ALLOWED_TARGET_HOSTS: 'api.example.com',
      MAX_UPSTREAM_RESPONSE_BYTES: '',
      UPSTREAM_TIMEOUT_MS: ' ',
    }).forward({ AccessPoint: 'https://api.example.com/' });
    expect(sentConfig().maxContentLength).toBe(5 * 1024 * 1024);
    expect(sentConfig().timeout).toBe(15000);
  });

  it.each(['0', '-1', 'NaN', '100mb', '1.5', 'Infinity'])(
    'rejects unsafe response limits: %s',
    (value) => {
      expect(() => makeService({ MAX_UPSTREAM_RESPONSE_BYTES: value })).toThrow(
        /positive safe integer/,
      );
    },
  );

  describe('ALLOWED_ROUTES', () => {
    const routed = () =>
      makeService({
        ALLOWED_ROUTES:
          'POST api.example.com/api/login, GET api.example.com/api/items/*',
      });

    it('allows listed method + path', async () => {
      await expect(
        routed().forward({
          AccessPoint: 'https://api.example.com/api/items/7',
          Method: 'GET',
        }),
      ).resolves.toBeDefined();
    });

    it.each([
      ['GET', 'https://api.example.com/api/login'],
      ['GET', 'https://api.example.com/admin'],
      ['DELETE', 'https://api.example.com/api/items/7'],
    ])('rejects %s %s before calling upstream', async (Method, AccessPoint) => {
      await expect(
        routed().forward({ AccessPoint, Method }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(request).not.toHaveBeenCalled();
    });

    it('fails at startup on a bad entry', () => {
      expect(() =>
        makeService({ ALLOWED_ROUTES: 'https://api.example.com/x' }),
      ).toThrow(/remove the scheme/);
    });
  });

  it('forwards a JSON-value Body and object Parameter (v2 style)', async () => {
    await service().forward({
      AccessPoint: 'https://api.example.com/',
      Method: 'PUT',
      Body: { items: [1, 2], ok: true },
      Parameter: { page: 3 },
    });

    expect(sentConfig().data).toEqual({ items: [1, 2], ok: true });
    expect(sentConfig().params).toEqual({ page: 3 });
  });
});
