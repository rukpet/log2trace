/**
 * OpenTelemetry Common Data Types
 * Based on opentelemetry-proto/common/v1/common.proto
 * 
 * These types are shared across all OpenTelemetry signals (traces, metrics, logs)
 */

/**
 * AnyValue is used to represent any type of attribute value.
 * The value can be a primitive (string, bool, int, double, bytes) or a complex structure (array, key-value list).
 */
export interface AnyValue {
  /** UTF-8 string value. */
  stringValue?: string;
  /** Boolean value. */
  boolValue?: boolean;
  /** Signed 64-bit integer value (encoded as decimal string or number in JSON). */
  intValue?: string | number;
  /** IEEE 754 double-precision floating-point value. */
  doubleValue?: number;
  /** Homogeneous or heterogeneous array value. */
  arrayValue?: ArrayValue;
  /** Nested key-value map value. */
  kvlistValue?: KeyValueList;
  /** Base64-encoded byte sequence. */
  bytesValue?: string;
}

/**
 * ArrayValue is a list of AnyValue messages.
 */
export interface ArrayValue {
  /** Elements of the array; may be empty. */
  values: AnyValue[];
}

/**
 * KeyValueList is a list of KeyValue messages.
 */
export interface KeyValueList {
  /** Key-value entries in the list. */
  values: KeyValue[];
}

/**
 * KeyValue is a key-value pair that is used to store attributes, etc.
 */
export interface KeyValue {
  /** Attribute or property key. */
  key: string;
  /** Attribute value. */
  value: AnyValue;
}

/**
 * Extract a string from an AnyValue, returning undefined if not a string.
 * @internal
 */
export function extractString(value?: AnyValue): string | undefined {
  return value?.stringValue;
}

/**
 * InstrumentationScope represents the instrumentation scope information
 * such as the fully qualified name and version.
 */
export interface InstrumentationScope {
  /** An empty instrumentation scope name means the name is unknown */
  name: string;
  
  /** An empty instrumentation scope version means the version is unknown */
  version?: string;
  
  /** Additional attributes that describe the scope */
  attributes?: KeyValue[];
  
  /** The number of attributes that were discarded */
  droppedAttributesCount?: number;
}

/**
 * EntityRef is a reference to an Entity.
 * Entity represents an object of interest associated with produced telemetry.
 * Status: Development
 * @internal
 */
export interface EntityRef {
  /** The Schema URL, if known */
  schemaUrl?: string;
  
  /** Defines the type of the entity (e.g., "service" or "host") */
  type: string;
  
  /** Attribute keys that identify the entity */
  idKeys: string[];
  
  /** Descriptive (non-identifying) attribute keys of the entity */
  descriptionKeys?: string[];
}
