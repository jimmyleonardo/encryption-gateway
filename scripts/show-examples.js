/**
 * Generate and verify the README examples with the real Web SDK and gateway
 * crypto/controller. Upstream responses are fictional fixtures; no network,
 * .env secrets, or persisted private keys are used.
 * Run: npm run examples (Markdown), npm run examples -- --json (JSON).
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { EncryptionService } from '../dist/encryption/encryption.service.js';
import { ProxyController } from '../dist/proxy/proxy.controller.js';
import { GatewayClient } from '../clients/web/gatewayClient.js';

Logger.overrideLogger(false);

const fixtures = [
  {
    title: '1. Login: user, permissions, and session (200)',
    note: 'A successful login returns user details and two Set-Cookie values. These cookies remain data in the envelope; browser cookie storage is not updated automatically.',
    request: {
      method: 'POST',
      accessPoint: 'https://api.example.com/api/login',
      headers: { 'Content-Type': 'application/json', 'X-App-Version': '1.4.0' },
      body: {
        email: 'budi@example.com',
        password: 'demo-password-only',
        device: { platform: 'android', appVersion: '1.4.0' },
      },
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-demo-login-001',
        'set-cookie': [
          'session=demo-session; Path=/; HttpOnly; Secure; SameSite=Lax',
          'locale=id-ID; Path=/; Secure; SameSite=Lax',
        ],
      },
      data: {
        success: true,
        message: 'Login successful',
        user: {
          id: 'usr_123',
          name: 'Budi Santoso',
          email: 'budi@example.com',
          roles: ['customer'],
          permissions: ['profile:read', 'orders:create', 'orders:read'],
          profile: {
            locale: 'id-ID',
            timezone: 'Asia/Jakarta',
            emailVerified: true,
          },
        },
        session: {
          accessToken: 'demo-access-token-not-a-real-jwt',
          tokenType: 'Bearer',
          expiresIn: 3600,
          refreshToken: 'demo-refresh-token',
          issuedAt: '2026-10-01T07:00:00Z',
        },
      },
    },
  },
  {
    title: '2. Product search: query parameters and pagination (200)',
    note: 'Parameter becomes the upstream query string. GET bodies are omitted. This example includes multiple products, nested variants, filters, and pagination.',
    request: {
      method: 'GET',
      accessPoint: 'https://api.example.com/api/products',
      headers: { Authorization: 'Bearer demo-access-token-not-a-real-jwt' },
      parameter: {
        page: 1,
        limit: 2,
        search: 'coffee',
        category: ['beans', 'equipment'],
        sort: 'price_asc',
      },
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-demo-products-002',
      },
      data: {
        success: true,
        items: [
          {
            id: 'prd_101',
            name: 'Gayo Arabica Coffee Beans',
            category: 'beans',
            price: { amount: 85000, currency: 'IDR' },
            stock: 42,
            rating: { average: 4.8, reviews: 127 },
            variants: [
              {
                sku: 'GAYO-250-WHOLE',
                weightGrams: 250,
                grind: 'whole-bean',
                available: true,
              },
              {
                sku: 'GAYO-250-FILTER',
                weightGrams: 250,
                grind: 'filter',
                available: true,
              },
            ],
          },
          {
            id: 'prd_205',
            name: 'Pour-over Coffee Dripper',
            category: 'equipment',
            price: { amount: 120000, currency: 'IDR' },
            stock: 18,
            rating: { average: 4.6, reviews: 83 },
            variants: [
              { sku: 'DRIPPER-02-WHITE', color: 'white', available: true },
            ],
          },
        ],
        pagination: {
          page: 1,
          limit: 2,
          totalItems: 18,
          totalPages: 9,
          hasNextPage: true,
          nextPage: 2,
        },
        filters: {
          search: 'coffee',
          category: ['beans', 'equipment'],
          sort: 'price_asc',
        },
      },
    },
  },
  {
    title: '3. Create an order: nested body and idempotency key (201)',
    note: 'The gateway transports the Idempotency-Key header. The backend must implement idempotency. Gateway HTTP status is 200; the backend creation status is StatusCode: 201.',
    request: {
      method: 'POST',
      accessPoint: 'https://api.example.com/api/orders',
      headers: {
        Authorization: 'Bearer demo-access-token-not-a-real-jwt',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'demo-order-20261001-001',
      },
      body: {
        items: [
          { productId: 'prd_101', sku: 'GAYO-250-WHOLE', quantity: 2 },
          { productId: 'prd_205', sku: 'DRIPPER-02-WHITE', quantity: 1 },
        ],
        shippingAddress: {
          recipient: 'Budi Santoso',
          phone: '+6281200000000',
          street: 'Jl. Contoh No. 10',
          city: 'Jakarta Selatan',
          postalCode: '12345',
          country: 'ID',
        },
        paymentMethod: 'bank_transfer',
        notes: 'Please use recyclable packaging.',
      },
    },
    response: {
      status: 201,
      headers: {
        'content-type': 'application/json',
        location: '/api/orders/ord_9001',
        'x-request-id': 'req-demo-order-003',
      },
      data: {
        success: true,
        message: 'Order created',
        order: {
          id: 'ord_9001',
          number: 'ORD-20261001-9001',
          status: 'awaiting_payment',
          createdAt: '2026-10-01T07:05:00Z',
          items: [
            {
              productId: 'prd_101',
              name: 'Gayo Arabica Coffee Beans',
              quantity: 2,
              unitPrice: 85000,
              subtotal: 170000,
            },
            {
              productId: 'prd_205',
              name: 'Pour-over Coffee Dripper',
              quantity: 1,
              unitPrice: 120000,
              subtotal: 120000,
            },
          ],
          totals: {
            currency: 'IDR',
            subtotal: 290000,
            shipping: 15000,
            discount: 10000,
            grandTotal: 295000,
          },
          shipping: {
            recipient: 'Budi Santoso',
            city: 'Jakarta Selatan',
            service: 'standard',
            estimatedDeliveryDays: { min: 2, max: 4 },
          },
          payment: {
            method: 'bank_transfer',
            status: 'pending',
            reference: 'PAY-DEMO-9001',
            expiresAt: '2026-10-02T07:05:00Z',
          },
        },
      },
    },
  },
  {
    title: '4. Update a profile: backend validation errors (422)',
    note: 'Business errors are encrypted in encrypted-response mode too. The SDK returns this result; inspect StatusCode to distinguish it from a gateway transport error.',
    request: {
      method: 'PATCH',
      accessPoint: 'https://api.example.com/api/profile',
      headers: {
        Authorization: 'Bearer demo-access-token-not-a-real-jwt',
        'Content-Type': 'application/json',
      },
      body: { name: '', email: 'invalid-email', phone: 'abc' },
    },
    response: {
      status: 422,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-demo-validation-004',
      },
      data: {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Please correct the highlighted fields',
          fields: [
            {
              field: 'name',
              code: 'REQUIRED',
              message: 'Name must not be empty',
            },
            {
              field: 'email',
              code: 'INVALID_FORMAT',
              message: 'Email must be a valid email address',
            },
            {
              field: 'phone',
              code: 'INVALID_FORMAT',
              message:
                'Phone must use international format, for example +6281200000000',
            },
          ],
        },
        meta: {
          requestId: 'req-demo-validation-004',
          retryable: false,
          submittedAt: '2026-10-01T07:10:00Z',
        },
      },
    },
  },
  {
    title: '5. Delete cart items: DELETE with a JSON body (200)',
    note: 'DELETE bodies are forwarded. Partial business results remain intact: the backend can report removed, missing, and remaining items in one response.',
    request: {
      method: 'DELETE',
      accessPoint: 'https://api.example.com/api/cart/items',
      headers: {
        Authorization: 'Bearer demo-access-token-not-a-real-jwt',
        'Content-Type': 'application/json',
      },
      body: {
        itemIds: ['cart_101', 'cart_205', 'cart_missing'],
        reason: 'customer_removed',
      },
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-demo-delete-005',
      },
      data: {
        success: true,
        message: 'Cart updated',
        removed: [
          { id: 'cart_101', productId: 'prd_101', quantity: 2 },
          { id: 'cart_205', productId: 'prd_205', quantity: 1 },
        ],
        notFound: ['cart_missing'],
        cart: {
          id: 'cart_budi',
          remainingItems: [
            {
              id: 'cart_333',
              productId: 'prd_333',
              name: 'Paper Coffee Filters',
              quantity: 1,
              unitPrice: 35000,
              subtotal: 35000,
            },
          ],
          totals: { currency: 'IDR', itemCount: 1, subtotal: 35000 },
          updatedAt: '2026-10-01T07:15:00Z',
        },
      },
    },
  },
];

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = (values) => ({ get: (name) => values[name] });
const encryption = new EncryptionService(
  config({
    NODE_ENV: 'test',
    AUTO_GENERATE_KEYS: 'false',
    RSA_PRIVATE_KEY: privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  }),
);
encryption.onModuleInit();
const key = encryption.getPublicKeyInfo();
const gatewayUrl = 'https://gateway.example.com/api/gateway';
const originalFetch = globalThis.fetch;
const examples = [];

try {
  for (const fixture of fixtures) {
    const example = { title: fixture.title, note: fixture.note };
    let plainResult;
    for (const mode of ['false', 'true']) {
      const controller = new ProxyController(
        encryption,
        {
          forward: async (payload) => {
            const expected = JSON.parse(
              JSON.stringify({
                Method: fixture.request.method,
                AccessPoint: fixture.request.accessPoint,
                Header: Object.entries(fixture.request.headers).map(
                  ([Key, Value]) => ({ Key, Value }),
                ),
                Body: fixture.request.body,
                Parameter: fixture.request.parameter,
              }),
            );
            assert.deepEqual(payload, expected);
            example.PlainRequest = payload;
            return fixture.response;
          },
        },
        config({ ENCRYPT_RESPONSE: mode }),
      );
      globalThis.fetch = async (url, options) => {
        assert.equal(url, gatewayUrl);
        assert.equal(options.method, 'POST');
        const request = JSON.parse(options.body);
        assert.equal(request.AccessPoint, undefined);
        const response = await controller.handleGateway(request);
        if (mode === 'true') {
          assert.notEqual(response.IV, request.IV);
          example.EncryptedRequest = request;
          example.EncryptedResponse = response;
        } else {
          example.PlainResponse = response;
        }
        return new Response(JSON.stringify(response), { status: 200 });
      };
      const client = new GatewayClient(gatewayUrl, key.pem, key.keyId, {
        requireEncryptedResponse: mode === 'true',
      });
      const result = await client.send(fixture.request);
      assert.deepEqual(result, {
        StatusCode: fixture.response.status,
        Headers: fixture.response.headers,
        Data: fixture.response.data,
      });
      if (mode === 'false') plainResult = result;
      else {
        assert.deepEqual(result, plainResult);
        example.DecryptedResponse = result;
      }
    }
    examples.push(example);
  }
} finally {
  globalThis.fetch = originalFetch;
}

const block = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';
const markdown = examples
  .map((example) =>
    [
      '### ' + example.title,
      '',
      example.note,
      '',
      '**Plain request before SDK encryption (client memory / gateway-to-backend hop)**',
      '',
      block(example.PlainRequest),
      '',
      '**Plain gateway response — `ENCRYPT_RESPONSE=false` (gateway HTTP 200)**',
      '',
      block(example.PlainResponse),
      '',
      '<details>',
      '<summary>Full encrypted request and encrypted response for this example</summary>',
      '',
      '**Encrypted request — `POST /api/gateway`, `Content-Type: application/json`**',
      '',
      block(example.EncryptedRequest),
      '',
      '**Encrypted gateway response — `ENCRYPT_RESPONSE=true` (gateway HTTP 200)**',
      '',
      block(example.EncryptedResponse),
      '',
      '</details>',
      '',
      '**Decrypted response returned by the Web SDK**',
      '',
      block(example.DecryptedResponse),
      '',
    ].join('\n'),
  )
  .join('\n');

console.log(
  process.argv.includes('--json')
    ? JSON.stringify(examples, null, 2)
    : markdown,
);
console.error(
  `Verified ${examples.length} examples in both response modes with the real Web SDK and gateway crypto/controller.`,
);
