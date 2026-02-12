/**
 * OpenTelemetry Trace Data Types
 * Based on opentelemetry-proto/trace/v1/trace.proto
 */

import { 
  KeyValue, 
  InstrumentationScope 
} from './common.js';
import { Resource } from './resource.js';

/**
 * SpanKind is the type of span. Can be used to specify additional relationships between spans
 * in addition to a parent/child relationship.
 */
export enum SpanKind {
  /** Unspecified. Do NOT use as default. */
  Unspecified = 0,
  /** Indicates that the span represents an internal operation within an application. */
  Internal = 1,
  /** Indicates that the span covers server-side handling of an RPC or other remote network request. */
  Server = 2,
  /** Indicates that the span describes a request to some remote service. */
  Client = 3,
  /** Indicates that the span describes a producer sending a message to a broker. */
  Producer = 4,
  /** Indicates that the span describes consumer receiving a message from a broker. */
  Consumer = 5
}

/**
 * Event is a time-stamped annotation of the span, consisting of user-supplied
 * text description and key-value pairs.
 */
export interface Event {
  /** The time the event occurred (UNIX Epoch time in nanoseconds). */
  timeUnixNano: string;
  /** The name of the event. This field is semantically required to be set to non-empty string. */
  name: string;
  /** A collection of attribute key/value pairs on the event. */
  attributes: KeyValue[];
  /** The number of dropped attributes. If the value is 0, then no attributes were dropped. */
  droppedAttributesCount?: number;
}

/**
 * A pointer from the current span to another span in the same trace or in a different trace.
 * For example, this can be used in batching operations, where a single batch handler processes
 * multiple requests from different traces.
 */
export interface Link {
  /** A unique identifier of a trace that this linked span is part of. The ID is a 16-byte array. */
  traceId: string;
  /** A unique identifier for the linked span. The ID is an 8-byte array. */
  spanId: string;
  /** A collection of attribute key/value pairs on the link. */
  attributes?: KeyValue[];
}

/**
 * The Status type defines a logical error model that is suitable for different
 * programming environments, including REST APIs and RPC APIs.
 */
export interface Status {
  /** The status code. 0 = Unset, 1 = Ok, 2 = Error */
  code: number;
  /** A developer-facing human readable error message. */
  message?: string;
}

/**
 * A Span represents a single operation performed by a single component of the system.
 */
export interface Span {
  /** 
   * A unique identifier for a trace. All spans from the same trace share the same `trace_id`.
   * The ID is a 16-byte array. This field is required.
   */
  traceId: string;
  /** 
   * A unique identifier for a span within a trace, assigned when the span is created.
   * The ID is an 8-byte array. This field is required.
   */
  spanId: string;
  /** 
   * The `span_id` of this span's parent span. If this is a root span, then this field must be empty.
   * The ID is an 8-byte array.
   */
  parentSpanId?: string;
  /** 
   * A description of the span's operation. For example, the name can be a qualified method name
   * or a file name and a line number where the operation is called.
   * This field is semantically required to be set to non-empty string.
   */
  name: string;
  /** 
   * Distinguishes between spans generated in a particular context. For example, two spans with
   * the same name may be distinguished using `CLIENT` (caller) and `SERVER` (callee) to identify
   * queueing latency associated with the span.
   */
  kind: SpanKind;
  /** 
   * The start time of the span. On the client side, this is the time kept by the local machine
   * where the span execution starts. Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC
   * on 1 January 1970.
   */
  startTimeUnixNano: string;
  /** 
   * The end time of the span. On the client side, this is the time kept by the local machine
   * where the span execution ends. Value is UNIX Epoch time in nanoseconds since 00:00:00 UTC
   * on 1 January 1970.
   */
  endTimeUnixNano: string;
  /** 
   * A collection of key/value pairs. Note, global attributes like server name can be set using
   * the resource API. Attribute keys MUST be unique.
   */
  attributes: KeyValue[];
  /** A collection of Event items. */
  events?: Event[];
  /** A collection of Links, which are references from this span to a span in the same or different trace. */
  links?: Link[];
  /** An optional final status for this span. When Status isn't set, it means span's status code is unset. */
  status?: Status;
  /** 
   * The number of attributes that were discarded. Attributes can be discarded because their keys
   * are too long or because there are too many attributes. If this value is 0, then no attributes were dropped.
   */
  droppedAttributesCount?: number;
  /** The number of dropped events. If the value is 0, then no events were dropped. */
  droppedEventsCount?: number;
  /** The number of dropped links. If the value is 0, then no links were dropped. */
  droppedLinksCount?: number;
}

/**
 * A collection of Spans produced by an InstrumentationScope.
 */
export interface ScopeSpans {
  /** 
   * The instrumentation scope information for the spans in this message.
   * Semantically when InstrumentationScope isn't set, it is equivalent with an empty instrumentation scope name (unknown).
   */
  scope: InstrumentationScope;
  /** A list of Spans that originate from an instrumentation scope. */
  spans: Span[];
  /** 
   * The Schema URL, if known. This is the identifier of the Schema that the span data is recorded in.
   * See https://opentelemetry.io/docs/specs/otel/schemas/#schema-url
   */
  schemaUrl?: string;
}

/**
 * A collection of ScopeSpans from a Resource.
 */
export interface ResourceSpans {
  /** 
   * The resource for the spans in this message. If this field is not set then no resource info is known.
   */
  resource: Resource;
  /** A list of ScopeSpans that originate from a resource. */
  scopeSpans: ScopeSpans[];
  /** 
   * The Schema URL, if known. This is the identifier of the Schema that the resource data is recorded in.
   * This schema_url applies to the data in the "resource" field. It does not apply to the data in the
   * "scope_spans" field which have their own schema_url field.
   */
  schemaUrl?: string;
}

/**
 * TracesData represents the traces data that can be stored in persistent storage,
 * OR can be embedded by other protocols that transfer OTLP traces data but do not implement the OTLP protocol.
 */
export interface TraceData {
  /** 
   * An array of ResourceSpans. For data coming from a single resource this array will typically contain
   * one element. Intermediary nodes that receive data from multiple origins typically batch the data
   * before forwarding further and in that case this array will contain multiple elements.
   */
  resourceSpans: ResourceSpans[];
}
