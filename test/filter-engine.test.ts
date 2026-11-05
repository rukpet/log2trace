/**
 * The filter engine: the mask-based `matchSpans`, the Set-based `filterSpanIds` that the
 * legacy element still uses, and the external-filter helpers.
 *
 * The expectations for the demo data were recorded from the implementation before the
 * rework (1.0.0-RC2) (sizes and a fingerprint of the sorted ids), so a refactor that changes which spans
 * match fails here. Quirks of the old matching are kept on purpose and noted in the case names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areRequiredExternalFiltersFilled,
  buildQueryParams,
  compileFilters,
  filterSpanIds,
  matchSpans,
} from '../src/core/filter.ts';
import type { Filter, FilterFieldType, FilterTarget, FilterValue } from '../src/core/config.ts';
import type { SpanIndex } from '../src/core/span-index.ts';
import { demoLogsIndex, demoOtelIndex, sha256 } from './support/demo-data.ts';

function filter(
  field: string,
  type: FilterFieldType,
  value: FilterValue,
  target: FilterTarget = 'span',
  required = false,
): Filter {
  return {
    config: {
      field, label: field, type, source: 'local', target, required,
      options: [], optionsSource: 'static', placeholder: '', debounce: 0, width: 0, autoRange: false,
    },
    value,
  };
}

/** `null`: no filter is active. Otherwise the number of matching spans and the fingerprint of their sorted ids. */
type Expected = null | readonly [size: number, sha: string];

interface Case {
  readonly filters: Filter[];
  readonly expected: Expected;
}

const ALL_94 = '7685777d376951fc38974ec98f852d42eb7cf2afa96ce0390b0e582d9fc7a8e9';
const NONE = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ERRORS_7 = '33648302f48c4d71acb32d2a6bc542a46a38adaa6e20e327d29ca47bc1ad0d3f';
const CREATE_16 = '9d653643c6a6f36e555182425fcca492d8ebe12f4cbd1400bf7728e1b409df35';

// The window the range cases use: 20 s and 90 s after the first span of demo/logs.json (UTC, so the test does not depend on the time zone).
const FROM = '2026-02-26T05:37:40.340Z';
const TO = '2026-02-26T05:38:50.340Z';

const LOGS_CASES: Record<string, Case> = {
  inactive: {
    filters: [filter('spanName', 'text', ''), filter('hasError', 'checkbox', false), filter('serviceName', 'multiselect', [])],
    expected: null,
  },
  wildcardError: { filters: [filter('*', 'text', 'error')], expected: [45, '873efca2a98c04ec188af6be448152ca150093ac9a1122f538be2d75f9b3e37f'] },
  wildcardIsCaseInsensitive: { filters: [filter('*', 'text', 'USER')], expected: [93, '63f026a69ec378c8c2329335c44284882ff0760df21f204be13307216b2f9886'] },
  wildcardOfAnotherTypeMatchesEverything: { filters: [filter('*', 'dropdown', 'user')], expected: [94, ALL_94] },
  spanNameText: { filters: [filter('spanName', 'text', 'user')], expected: [73, '243ca51e0e0dfcbc1ef56efcaab2de176b53de65e161c595e355688fcb1ed317'] },
  nameIsAnAliasOfSpanName: { filters: [filter('name', 'text', 'create')], expected: [16, CREATE_16] },
  serviceDropdown: { filters: [filter('serviceName', 'dropdown', 'data-api-v3.1.4')], expected: [11, '78fd09a6017d8fb3ab64801e607171866fe97ee2073225b37f4fec579b780852'] },
  serviceMultiselect: {
    filters: [filter('serviceName', 'multiselect', ['workflow-engine-v2.5.3', 'content-api-v2.0.6'])],
    expected: [18, 'b2c5b16444311493e4da32f69acdedc5b57544e0ef67c84df8d79ab047d2758b'],
  },
  hasError: { filters: [filter('hasError', 'checkbox', true)], expected: [7, ERRORS_7] },
  kindDropdown: { filters: [filter('spanKind', 'dropdown', '2')], expected: [8, 'fb9bb4967643d735cb29c77aed683a4975bc5e8e38e18dd7780641d9fed124ca'] },
  kindIsAnAliasOfSpanKind: { filters: [filter('kind', 'multiselect', ['0', '5'])], expected: [57, '161fd79babf21fc68229b73e1fa8ce17d7d4af7c4973705552ba7e3414cdf254'] },
  spanAttribute: { filters: [filter('log2trace.log_count', 'dropdown', '2')], expected: [40, 'd9d92c24551d3b584fcac4017676ba6c1571e7d02bc70e17148cb749baaa71b4'] },
  dotPathIntoTheSpan: { filters: [filter('status.code', 'dropdown', '2')], expected: [7, ERRORS_7] },
  checkboxOnAnAttributeMeansPresent: { filters: [filter('log2trace.log_count', 'checkbox', true)], expected: [94, ALL_94] },
  rangeWithBothBounds: { filters: [filter('startTime', 'datetime-range', { from: FROM, to: TO })], expected: [13, '5457e092a27a6071d1299cc4e99b64d68a1b02c3be5ada223d7af3dcfb4003b0'] },
  rangeFromOnly: { filters: [filter('startTime', 'datetime-range', { from: FROM })], expected: [17, '0e08381a98f912e567d66f7e392d6c33990ec88d5b656e4d2a7c9c11684321d4'] },
  rangeToOnly: { filters: [filter('startTime', 'datetime-range', { to: FROM })], expected: [77, 'f7bc8cf659f5ffa3d6794900a1d05922f4a812052a2a9cad8b06e7578d62dfff'] },
  rangeWithAnUnparsableBoundFiltersNothing: { filters: [filter('startTime', 'datetime-range', { from: 'not a date' })], expected: [94, ALL_94] },
  logText: { filters: [filter('text.Action', 'text', 'Create', 'log')], expected: [16, CREATE_16] },
  logDropdownOnEveryEvent: { filters: [filter('metadata.severity', 'dropdown', 'Info', 'log')], expected: [94, ALL_94] },
  logCheckbox: { filters: [filter('text.Code', 'checkbox', true, 'log')], expected: [94, ALL_94] },
  logMultiselect: { filters: [filter('metadata.severity', 'multiselect', ['Info', 'Error'], 'log')], expected: [94, ALL_94] },
  logFieldThatNoEventHas: { filters: [filter('nothing.here', 'text', 'x', 'log')], expected: [0, NONE] },
  filtersCombineWithAnd: { filters: [filter('*', 'text', 'user'), filter('hasError', 'checkbox', true)], expected: [7, ERRORS_7] },
  spanAndLogFilterTogether: {
    filters: [filter('serviceName', 'dropdown', 'data-api-v3.1.4'), filter('text.Action', 'text', 'Create', 'log')],
    expected: [1, '8537ab477d9de73c439736766a2c28e79a0b8577a8912fd912f091e5478f5727'],
  },
  nothingMatches: { filters: [filter('spanName', 'text', 'zzzzzz-no-such-span')], expected: [0, NONE] },
};

const MS_OF_OTEL_START = 1706889600000;

const OTEL_CASES: Record<string, Case> = {
  serviceMultiselect: {
    filters: [filter('serviceName', 'multiselect', ['order-service', 'payment-service'])],
    expected: [5, '70d15e58c5c92b9288e6caa380da51e470c6b6e49fb33f004d7dd7a90904472e'],
  },
  wildcardReachesAttributes: { filters: [filter('*', 'text', 'grpc')], expected: [4, '89cf1a5de3cde33ad05de068646e5739542dbd54efc0a9a39f864b08cf17dc6a'] },
  attributeDropdown: { filters: [filter('db.system', 'dropdown', 'postgresql')], expected: [2, '50fc58e50a3c978d55c37df4eff861b72aa17e4d7d2c3fb6f6502951f65ed16a'] },
  kindDropdown: { filters: [filter('kind', 'dropdown', '3')], expected: [5, '3413c3587f54f85ee5d7c954effa1f98808625f7665f7617e3fe3dcf742e00ae'] },
  integerAttribute: { filters: [filter('items.checked', 'dropdown', '3')], expected: [1, '8bd07264510c18a6eb3043322433b02832c0d5596d8b7383f0e6d65abe5ff746'] },
  // The old matcher reads string, int and bool attributes but not doubles; kept as it was.
  doubleAttributeIsNotMatched: { filters: [filter('shipping.cost', 'dropdown', '12.5')], expected: [0, NONE] },
  rangeInMilliseconds: {
    filters: [filter('startTime', 'datetime-range', {
      from: new Date(MS_OF_OTEL_START + 500).toISOString(),
      to: new Date(MS_OF_OTEL_START + 1000).toISOString(),
    })],
    expected: [5, '03e7fc4f06d7ed722ed4a1cc883ee5d13ab59c13cb2f16420ba6a34d9674b941'],
  },
  logEventName: { filters: [filter('name', 'text', 'e', 'log')], expected: [4, '009f280a50dbfd7432e29eefbf7519c9437434a0340e179925b493e6f205e5f2'] },
};

function runCases(name: string, index: () => SpanIndex, cases: Record<string, Case>): void {
  for (const [title, { filters, expected }] of Object.entries(cases)) {
    test(`${name}: ${title}`, () => {
      const spans = index();
      const ids = filterSpanIds(spans.spans.values(), filters);
      const mask = matchSpans(spans, filters);

      if (expected === null) {
        assert.equal(ids, null);
        assert.equal(mask, null);
        return;
      }
      const [size, sha] = expected;
      assert.ok(ids !== null && mask !== null, 'the filters are active');
      assert.equal(ids.size, size);
      assert.equal(sha256([...ids].sort()), sha);
      assert.equal(mask.size, size);
      assert.equal(sha256([...mask].sort()), sha, 'the mask holds the same spans as the Set');
    });
  }
}

runCases('demo/logs.json', demoLogsIndex, LOGS_CASES);
runCases('demo/otel-trace.json', demoOtelIndex, OTEL_CASES);

test('matchSpans returns a mask over the rows of the index it was given', () => {
  const index = demoLogsIndex();
  const mask = matchSpans(index, [filter('hasError', 'checkbox', true)]);
  assert.ok(mask);

  assert.equal(mask.index, index);
  assert.equal(mask.bits.length, index.size);
  const ids = [...mask];
  assert.equal(ids.length, 7);
  const rows = ids.map((id) => index.spans.get(id)?.idx ?? -1);
  assert.deepEqual(rows, rows.slice().sort((a, b) => a - b), 'iteration is in row order');
  for (const id of ids) {
    assert.equal(mask.has(id), true);
    assert.equal(mask.hasRow(index.spans.get(id)?.idx ?? -1), true);
  }
  assert.equal(mask.has('not-a-span'), false);
});

test('compileFilters is null without an active filter and a predicate otherwise', () => {
  assert.equal(compileFilters([]), null);
  assert.equal(compileFilters([filter('spanName', 'text', '')]), null);

  const index = demoOtelIndex();
  const isError = compileFilters([filter('hasError', 'checkbox', true)]);
  assert.ok(isError);
  assert.equal(index.ordered.some(isError), false, 'no span of the otel demo is an error');

  const root = compileFilters([filter('serviceName', 'dropdown', 'frontend-web'), filter('*', 'text', 'checkout')]);
  assert.ok(root);
  assert.deepEqual(index.ordered.filter(root).map((s) => s.spanId), ['eee19b7ec3c1b174']);
});

test('required external filters gate the fetch', () => {
  assert.equal(areRequiredExternalFiltersFilled([]), true);
  assert.equal(areRequiredExternalFiltersFilled([filter('a', 'text', '', 'span', false)]), true, 'optional filters never block');
  assert.equal(areRequiredExternalFiltersFilled([filter('a', 'text', '', 'span', true)]), false);
  assert.equal(areRequiredExternalFiltersFilled([filter('a', 'text', 'x', 'span', true), filter('b', 'multiselect', [], 'span', true)]), false);
  assert.equal(areRequiredExternalFiltersFilled([filter('a', 'text', 'x', 'span', true), filter('b', 'checkbox', true, 'span', true)]), true);
});

test('buildQueryParams encodes active filters by type', () => {
  const params = buildQueryParams([
    filter('user', 'text', 'ada'),
    filter('window', 'datetime-range', { from: '2026-01-01T00:00', to: '2026-01-02T00:00' }),
    filter('since', 'datetime-range', { from: '2026-03-01T00:00' }),
    filter('failed', 'checkbox', true),
    filter('quiet', 'checkbox', false),
    filter('env', 'multiselect', ['prod', 'stage']),
    filter('empty', 'text', ''),
    filter('none', 'multiselect', []),
  ]);

  assert.deepEqual(params, {
    user: 'ada',
    windowFrom: '2026-01-01T00:00',
    windowTo: '2026-01-02T00:00',
    sinceFrom: '2026-03-01T00:00',
    failed: 'true',
    env: ['prod', 'stage'],
  });
});
