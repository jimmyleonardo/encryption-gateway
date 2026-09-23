import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  DecryptedPayload,
  validateParameterObject,
} from '../common/payload.js';
import { ALLOWED_METHODS, TargetPolicy } from './target-policy.js';
import { positiveInteger } from '../common/config.js';

export interface UpstreamResponse {
  status: number;
  data: unknown;
  headers: Record<string, string | string[]>;
}

const METHODS_WITHOUT_BODY = ['GET'];

/**
 * Headers the client must not control: hop-by-hop headers (RFC 7230
 * §6.1), plus ones the HTTP client computes itself. Forwarding these
 * could break framing or let the client spoof the upstream `Host`.
 */
const BLOCKED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'fastly-client-ip',
]);

/** RFC 7230 `token` — the only characters allowed in a header name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Visible ASCII, space, tab, obs-text. Rejects CR/LF and other controls. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly policy: TargetPolicy;
  private readonly allowHttp: boolean;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.policy = new TargetPolicy(
      this.configService.get<string>('ALLOWED_TARGET_HOSTS'),
      this.configService.get<string>('ALLOWED_ROUTES'),
    );
    this.allowHttp =
      this.configService.get<string>('ALLOW_HTTP_UPSTREAM') === 'true';
    this.timeoutMs = positiveInteger(
      configService,
      'UPSTREAM_TIMEOUT_MS',
      15000,
    );
    this.maxResponseBytes = positiveInteger(
      configService,
      'MAX_UPSTREAM_RESPONSE_BYTES',
      5 * 1024 * 1024,
    );

    if (this.policy.isEmpty) {
      this.logger.warn(
        'ALLOWED_TARGET_HOSTS and ALLOWED_ROUTES are empty: every gateway request will be rejected',
      );
    } else {
      this.logger.log(`Allowed targets: ${this.policy.describe().join(', ')}`);
    }
  }

  /**
   * Forwards the decrypted payload to `AccessPoint` using `Method`,
   * sending `Header` entries as HTTP headers and `Body`/`Parameter` as
   * the request payload / query string depending on the HTTP method.
   *
   * Non-2xx upstream responses are returned as-is (with their status) so
   * the client can tell them apart; only transport failures throw.
   */
  async forward(payload: DecryptedPayload): Promise<UpstreamResponse> {
    const { AccessPoint, Method: method, Header, Body, Parameter } = payload;

    const httpMethod = (method || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.includes(httpMethod)) {
      throw new BadRequestException(`Method "${httpMethod}" is not allowed`);
    }
    const url = this.validateAndBuildUrl(AccessPoint);
    this.policy.assertAllowed(httpMethod, url);
    const headers = this.normalizeHeaders(Header);

    let requestBody: unknown = undefined;
    if (
      Body != null &&
      Body !== '' &&
      !METHODS_WITHOUT_BODY.includes(httpMethod)
    ) {
      if (typeof Body === 'string') {
        try {
          requestBody = JSON.parse(Body);
        } catch {
          requestBody = Body; // not JSON, forward as raw string
        }
      } else {
        requestBody = Body; // already a JSON value (v2 style)
      }
    }

    let params: Record<string, unknown> | undefined;
    if (typeof Parameter === 'string' && Parameter) {
      try {
        const parsed: unknown = JSON.parse(Parameter);
        validateParameterObject(parsed);
        params = parsed;
      } catch {
        throw new BadRequestException(
          'Parameter must be valid JSON object data',
        );
      }
    } else if (Parameter && typeof Parameter === 'object') {
      validateParameterObject(Parameter);
      params = Parameter;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.request({
          url: url.toString(),
          method: httpMethod,
          headers,
          data: requestBody,
          params,
          timeout: this.timeoutMs,
          maxContentLength: this.maxResponseBytes,
          // Never follow redirects: a whitelisted host could otherwise
          // bounce the gateway to an internal address (SSRF).
          maxRedirects: 0,
          validateStatus: () => true, // pass non-2xx through to the client
        }),
      );

      return {
        status: response.status,
        data: response.data,
        headers: this.sanitizeResponseHeaders(response.headers),
      };
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.error(
        `Upstream request to ${url.host} failed: ${axiosErr.code ?? ''} ${axiosErr.message}`,
      );
      if (axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ETIMEDOUT') {
        throw new GatewayTimeoutException('Upstream API timed out');
      }
      throw new BadGatewayException('Failed to reach upstream API');
    }
  }

  private validateAndBuildUrl(accessPoint: string): URL {
    let url: URL;
    try {
      url = new URL(accessPoint);
    } catch {
      throw new BadRequestException('AccessPoint must be a valid absolute URL');
    }

    const protocolOk =
      url.protocol === 'https:' || (this.allowHttp && url.protocol === 'http:');
    if (!protocolOk) {
      throw new BadRequestException(
        `AccessPoint protocol "${url.protocol}" is not allowed`,
      );
    }
    return url;
  }

  /**
   * Normalizes the `Header` field, which on the legacy client is a
   * JSONArray. Supports both `[{ "Key": "X", "Value": "Y" }, ...]` and
   * `[{ "X": "Y" }, ...]` shapes, as well as a plain object map.
   */
  private normalizeHeaders(
    header: DecryptedPayload['Header'],
  ): Record<string, string> {
    const headers: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    const entries = Array.isArray(header) ? header : header ? [header] : [];
    const connectionHeaders = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const pairs =
        'Key' in entry && 'Value' in entry
          ? [[entry.Key, entry.Value]]
          : Object.entries(entry);
      for (const [name, value] of pairs) {
        if (String(name).toLowerCase() === 'connection') {
          for (const token of String(value).split(','))
            connectionHeaders.add(token.trim().toLowerCase());
        }
      }
    }
    const add = (key: unknown, value: unknown) => {
      const name = String(key);
      const text = String(value);
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(text)) {
        throw new BadRequestException(`Header "${name}" is not valid`);
      }
      const lower = name.toLowerCase();
      if (
        BLOCKED_HEADERS.has(lower) ||
        lower.startsWith('x-forwarded-') ||
        connectionHeaders.has(lower)
      ) {
        this.logger.warn(`Dropping blocked header from client: ${name}`);
        return;
      }
      headers[name] = text;
    };

    if (!header) return headers;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if ('Key' in entry && 'Value' in entry) {
        add(entry.Key, entry.Value);
      } else {
        for (const [k, v] of Object.entries(entry)) add(k, v);
      }
    }

    return headers;
  }

  private sanitizeResponseHeaders(
    headers?: Record<string, unknown>,
  ): Record<string, string | string[]> {
    if (!headers) return {};
    const dropped = new Set([
      'transfer-encoding',
      'content-encoding',
      'connection',
      'keep-alive',
      'content-length',
    ]);
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (dropped.has(lower) || value == null) continue;
      if (Array.isArray(value)) {
        out[lower] = value.map(String);
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        // Axios response headers contain scalar values or arrays of strings.
        // Ignore unexpected objects rather than exposing "[object Object]".
        out[lower] = String(value);
      }
    }
    return out;
  }
}
