/**
 * OpenTelemetry Logs Data Types
 * Based on opentelemetry-proto/logs/v1/logs.proto
 */

import { 
  AnyValue,
  KeyValue, 
  InstrumentationScope 
} from './common.js';
import { Resource } from './resource.js';

/**
 * Possible values for LogRecord.SeverityNumber
 */
export enum SeverityNumber {
  SEVERITY_NUMBER_UNSPECIFIED = 0,
  SEVERITY_NUMBER_TRACE = 1,
  SEVERITY_NUMBER_TRACE2 = 2,
  SEVERITY_NUMBER_TRACE3 = 3,
  SEVERITY_NUMBER_TRACE4 = 4,
  SEVERITY_NUMBER_DEBUG = 5,
  SEVERITY_NUMBER_DEBUG2 = 6,
  SEVERITY_NUMBER_DEBUG3 = 7,
  SEVERITY_NUMBER_DEBUG4 = 8,
  SEVERITY_NUMBER_INFO = 9,
  SEVERITY_NUMBER_INFO2 = 10,
  SEVERITY_NUMBER_INFO3 = 11,
  SEVERITY_NUMBER_INFO4 = 12,
  SEVERITY_NUMBER_WARN = 13,
  SEVERITY_NUMBER_WARN2 = 14,
  SEVERITY_NUMBER_WARN3 = 15,
  SEVERITY_NUMBER_WARN4 = 16,
  SEVERITY_NUMBER_ERROR = 17,
  SEVERITY_NUMBER_ERROR2 = 18,
  SEVERITY_NUMBER_ERROR3 = 19,
  SEVERITY_NUMBER_ERROR4 = 20,
  SEVERITY_NUMBER_FATAL = 21,
  SEVERITY_NUMBER_FATAL2 = 22,
  SEVERITY_NUMBER_FATAL3 = 23,
  SEVERITY_NUMBER_FATAL4 = 24
}

/**
 * A log record represents a single log event
 */
export interface LogRecord {
  /** Time when the event occurred (UNIX Epoch time in nanoseconds) */
  timeUnixNano: string;
  
  /** Time when the event was observed by the collection system (UNIX Epoch time in nanoseconds) */
  observedTimeUnixNano: string;
  
  /** Numerical value of the severity */
  severityNumber: SeverityNumber;
  
  /** The severity text (also known as log level) */
  severityText?: string;
  
  /** The body of the log record (can be string, number, boolean, or structured data) */
  body?: AnyValue;
  
  /** Additional attributes that describe the specific event occurrence */
  attributes: KeyValue[];
  
  /** Number of dropped attributes */
  droppedAttributesCount?: number;
  
  /** Flags, a bit field (8 least significant bits are trace flags) */
  flags?: number;
  
  /** Trace ID (16-byte array represented as hex string) */
  traceId?: string;
  
  /** Span ID (8-byte array represented as hex string) */
  spanId?: string;
  
  /** A unique identifier of event category/type */
  eventName?: string;
}

/**
 * A collection of logs produced by a scope
 */
export interface ScopeLogs {
  /** The instrumentation scope information for the logs */
  scope: InstrumentationScope;
  
  /** A list of log records */
  logRecords: LogRecord[];
  
  /** The Schema URL, if known */
  schemaUrl?: string;
}

/**
 * A collection of ScopeLogs from a Resource
 */
export interface ResourceLogs {
  /** The resource for the logs in this message */
  resource: Resource;
  
  /** A list of ScopeLogs that originate from a resource */
  scopeLogs: ScopeLogs[];
  
  /** The Schema URL, if known */
  schemaUrl?: string;
}

/**
 * LogsData represents the logs data that can be stored in persistent storage,
 * OR can be embedded in a trace or metrics stream that also contains logs data
 */
export interface LogsData {
  resourceLogs: ResourceLogs[];
}
