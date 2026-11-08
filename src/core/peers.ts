/**
 * Extracting uninstrumented peer dependencies from span attributes.
 *
 * Headless: no DOM, no browser globals.
 */

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
