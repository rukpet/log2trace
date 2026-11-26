import type { LogEntry, TraceData, TransformConfig } from '../../src/core/index.ts';

/** Fixed UTC epoch (2026-01-15T10:00:00.000Z) in milliseconds. */
export const BASE_MS = Date.UTC(2026, 0, 15, 10, 0, 0, 0);

function ns(offsetMs: number): string {
  return (BigInt(BASE_MS + offsetMs) * 1_000_000n).toString();
}

export const SAMPLE_TRACE_ID = '0102030405060708090a0b0c0d0e0f10';

/**
 * Deterministic 5-span OTel trace spanning 200 ms across 4 services (+ 1 inferred DB peer):
 *
 * - span-root  (api-gateway,     GET /orders,      Server, 0..200 ms,   OK,    event: request.received)
 *   - span-auth  (auth-service,    verifyToken,    Server, 10..50 ms,   OK)
 *   - span-order (order-service,   createOrder,    Server, 55..185 ms,  OK)
 *     - span-db    (order-service,   SELECT inventory, Client, 70..110 ms, OK, peer: inventory-db)
 *     - span-pay   (payment-service, chargeCard,   Server, 115..175 ms, Error, event: payment.failed)
 */
export const SAMPLE_TRACE: TraceData = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'api-gateway' } }],
      },
      scopeSpans: [
        {
          scope: { name: 'e2e' },
          spans: [
            {
              traceId: SAMPLE_TRACE_ID,
              spanId: 'span-root',
              name: 'GET /orders',
              kind: 2,
              startTimeUnixNano: ns(0),
              endTimeUnixNano: ns(200),
              attributes: [
                { key: 'http.method', value: { stringValue: 'GET' } },
                { key: 'http.route', value: { stringValue: '/orders' } },
              ],
              events: [
                {
                  timeUnixNano: ns(5),
                  name: 'request.received',
                  attributes: [{ key: 'client.ip', value: { stringValue: '10.0.0.1' } }],
                },
              ],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'auth-service' } }],
      },
      scopeSpans: [
        {
          scope: { name: 'e2e' },
          spans: [
            {
              traceId: SAMPLE_TRACE_ID,
              spanId: 'span-auth',
              parentSpanId: 'span-root',
              name: 'verifyToken',
              kind: 2,
              startTimeUnixNano: ns(10),
              endTimeUnixNano: ns(50),
              attributes: [{ key: 'auth.user', value: { stringValue: 'alice' } }],
              events: [],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'order-service' } }],
      },
      scopeSpans: [
        {
          scope: { name: 'e2e' },
          spans: [
            {
              traceId: SAMPLE_TRACE_ID,
              spanId: 'span-order',
              parentSpanId: 'span-root',
              name: 'createOrder',
              kind: 2,
              startTimeUnixNano: ns(55),
              endTimeUnixNano: ns(185),
              attributes: [{ key: 'order.id', value: { stringValue: 'ord-42' } }],
              events: [],
              status: { code: 1 },
            },
            {
              traceId: SAMPLE_TRACE_ID,
              spanId: 'span-db',
              parentSpanId: 'span-order',
              name: 'SELECT inventory',
              kind: 3,
              startTimeUnixNano: ns(70),
              endTimeUnixNano: ns(110),
              attributes: [
                { key: 'db.system', value: { stringValue: 'postgresql' } },
                { key: 'peer.service', value: { stringValue: 'inventory-db' } },
              ],
              events: [],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'payment-service' } }],
      },
      scopeSpans: [
        {
          scope: { name: 'e2e' },
          spans: [
            {
              traceId: SAMPLE_TRACE_ID,
              spanId: 'span-pay',
              parentSpanId: 'span-order',
              name: 'chargeCard',
              kind: 2,
              startTimeUnixNano: ns(115),
              endTimeUnixNano: ns(175),
              attributes: [{ key: 'payment.provider', value: { stringValue: 'stripe' } }],
              events: [
                {
                  timeUnixNano: ns(170),
                  name: 'payment.failed',
                  attributes: [{ key: 'reason', value: { stringValue: 'insufficient_funds' } }],
                },
              ],
              status: { code: 2, message: 'Card declined' },
            },
          ],
        },
      ],
    },
  ],
};

/** Small trace filtered to a single service, returned by `/fixtures/search?service=...`. */
export function filterSampleTraceByService(service: string): TraceData {
  if (!service) return SAMPLE_TRACE;
  return {
    resourceSpans: SAMPLE_TRACE.resourceSpans.filter((rs) =>
      rs.resource.attributes.some(
        (attr) => attr.key === 'service.name' && attr.value.stringValue === service,
      ),
    ),
  };
}

/** Deterministic raw logs transforming into 2 parent-child spans across 2 services. */
export const SAMPLE_LOGS: LogEntry[] = [
  {
    traceId: 'log-trace-1',
    service: 'edge-gateway',
    action: 'handleCheckout',
    timestamp: '2026-01-15T10:00:00.000Z',
    layer: 'api',
    status: 'OK',
  },
  {
    traceId: 'log-trace-1',
    service: 'billing-worker',
    action: 'captureFunds',
    parentService: 'edge-gateway',
    timestamp: '2026-01-15T10:00:00.025Z',
    layer: 'client',
    status: 'OK',
  },
  {
    traceId: 'log-trace-1',
    service: 'billing-worker',
    action: 'captureFunds',
    parentService: 'edge-gateway',
    timestamp: '2026-01-15T10:00:00.095Z',
    layer: 'client',
    status: 'ERROR',
  },
  {
    traceId: 'log-trace-1',
    service: 'edge-gateway',
    action: 'handleCheckout',
    timestamp: '2026-01-15T10:00:00.120Z',
    layer: 'api',
    status: 'OK',
  },
];

export const SAMPLE_LOG_CONFIG: TransformConfig = {
  traceIdField: 'traceId',
  spanGroupFields: ['service', 'action'],
  spanNameField: 'action',
  serviceNameField: 'service',
  timestampField: 'timestamp',
  statusCodeField: 'status',
  parentSpanLookupFields: ['parentService'],
  spanKindRules: [
    { match: { layer: 'api' }, kind: 'Server' },
    { match: { layer: 'client' }, kind: 'Client' },
  ],
};
