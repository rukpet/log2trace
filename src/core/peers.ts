/**
 * Extracting uninstrumented peer dependencies from span attributes, and deciding
 * which client or producer spans call one.
 *
 * Headless: no DOM, no browser globals.
 */

import { SpanKind } from './otel/trace.ts';
import type { SpanIndex } from './span-index.ts';

/** An uninstrumented peer dependency (database, cache, message broker, or external host) inferred from client/producer span attributes. */
export interface InferredPeer {
  readonly name: string;
}

/**
 * Extract the uninstrumented peer a span talks to from its OpenTelemetry semantic-convention attributes.
 *
 * Checks in priority order:
 * 1. `peer.service`
 * 2. `db.system` (with optional `:db.name`)
 * 3. `messaging.system` (with optional `:messaging.destination.name` or `:messaging.destination`)
 * 4. `rpc.service`
 * 5. `server.address`, `net.peer.name`, or `http.host`
 */
export function inferredPeerOf(index: SpanIndex, row: number): InferredPeer | null {
  const indexed = index.ordered[row];
  if (!indexed || !indexed.span.attributes) return null;
  const attrs = indexed.span.attributes;

  let peerService: string | undefined;
  let dbSystem: string | undefined;
  let dbName: string | undefined;
  let messagingSystem: string | undefined;
  let messagingDest: string | undefined;
  let rpcService: string | undefined;
  let serverAddress: string | undefined;

  for (const attr of attrs) {
    if (attr.key === 'peer.service' && attr.value.stringValue) peerService = attr.value.stringValue;
    else if (attr.key === 'db.system' && attr.value.stringValue) dbSystem = attr.value.stringValue;
    else if (attr.key === 'db.name' && attr.value.stringValue) dbName = attr.value.stringValue;
    else if (attr.key === 'messaging.system' && attr.value.stringValue) messagingSystem = attr.value.stringValue;
    else if ((attr.key === 'messaging.destination.name' || attr.key === 'messaging.destination') && attr.value.stringValue) messagingDest = attr.value.stringValue;
    else if (attr.key === 'rpc.service' && attr.value.stringValue) rpcService = attr.value.stringValue;
    else if ((attr.key === 'server.address' || attr.key === 'net.peer.name' || attr.key === 'http.host') && attr.value.stringValue) serverAddress = attr.value.stringValue;
  }

  if (peerService) return { name: peerService };
  if (dbSystem) return { name: dbName ? `${dbSystem}:${dbName}` : dbSystem };
  if (messagingSystem) return { name: messagingDest ? `${messagingSystem}:${messagingDest}` : messagingSystem };
  if (rpcService) return { name: rpcService };
  if (serverAddress) return { name: serverAddress };
  return null;
}

/** Fallback peer name for a leaf CLIENT/PRODUCER span that has no children and no peer attributes. */
export const EXTERNAL_PEER_NAME = '(external)';

/** Optional peer resolver callback signature for extracting an inferred peer from a span row. */
export type PeerResolver = (index: SpanIndex, row: number) => { readonly name: string } | null;

/**
 * Which spans call a peer, and the distinct peers they call.
 *
 * A peer id is `0 .. count - 1`, numbered in order of first appearance among the rows. A peer is
 * either a known service of the trace (`knownService[peer] >= 0`) or an uninstrumented one (`-1`:
 * a database, a broker, an external host, or the {@link EXTERNAL_PEER_NAME} fallback).
 */
export interface LeafPeers {
  /** Number of distinct peers. */
  readonly count: number;
  /** Display name of each peer id. */
  readonly names: readonly string[];
  /** Table service id (`SpanTable.svc` value) of each peer that is an instrumented service, or -1 for an uninstrumented one. */
  readonly knownService: Int32Array;
  /** First table row that calls each peer. */
  readonly firstRow: Int32Array;
  /** Peer id called by each table row, or -1 for a row that is not a leaf CLIENT/PRODUCER call to a peer. */
  readonly peerOfRow: Int32Array;
}

/**
 * Find the CLIENT and PRODUCER spans that call a peer.
 *
 * A span qualifies when no descendant belongs to another service (an instrumented callee would show
 * up as that service's own spans) and either `peerOf` names a peer for it or it has no children at
 * all, which makes it an {@link EXTERNAL_PEER_NAME} call. A span whose peer is its own service is
 * not a call. A peer that has the name of a service of the trace maps to that service.
 *
 * @param index - The trace.
 * @param peerOf - Resolves the peer a row talks to; defaults to {@link inferredPeerOf}.
 */
export function classifyLeafPeers(index: SpanIndex, peerOf: PeerResolver = inferredPeerOf): LeafPeers {
  const table = index.table;
  const n = table.length;

  const serviceByName = new Map<string, number>();
  for (let s = 0; s < table.services.length; s++) serviceByName.set(table.services[s], s);

  // Whether any descendant is in another service than the row: a child that is, or a same-service child that has one.
  const crossesServices = new Uint8Array(n);
  for (let r = n - 1; r > 0; r--) {
    const p = table.parent[r];
    if (p >= 0 && (table.svc[r] !== table.svc[p] || crossesServices[r] === 1)) crossesServices[p] = 1;
  }

  const names: string[] = [];
  const knownList: number[] = [];
  const firstRowList: number[] = [];
  const knownByName = new Map<string, number>();
  const unknownByName = new Map<string, number>();
  function intern(name: string, known: number, row: number): number {
    const byName = known >= 0 ? knownByName : unknownByName;
    let id = byName.get(name);
    if (id === undefined) {
      id = names.length;
      byName.set(name, id);
      names.push(name);
      knownList.push(known);
      firstRowList.push(row);
    }
    return id;
  }

  const peerOfRow = new Int32Array(n).fill(-1);
  for (let r = 0; r < n; r++) {
    const k = table.kind[r];
    if (k !== SpanKind.Client && k !== SpanKind.Producer) continue;
    if (crossesServices[r] === 1) continue;

    const peer = peerOf(index, r);
    if (peer !== null) {
      if (peer.name === table.services[table.svc[r]]) continue;
      const known = serviceByName.get(peer.name);
      peerOfRow[r] = intern(peer.name, known === undefined ? -1 : known, r);
    } else if (table.subtreeEnd[r] === r + 1) {
      peerOfRow[r] = intern(EXTERNAL_PEER_NAME, -1, r);
    }
  }

  return {
    count: names.length,
    names,
    knownService: Int32Array.from(knownList),
    firstRow: Int32Array.from(firstRowList),
    peerOfRow,
  };
}
