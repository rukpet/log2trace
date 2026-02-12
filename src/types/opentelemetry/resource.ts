/**
 * OpenTelemetry Resource Data Types
 * Based on opentelemetry-proto/resource/v1/resource.proto
 */

import { KeyValue, EntityRef } from './common.js';

/**
 * Resource information. A Resource is an immutable representation of the entity
 * producing telemetry as Attributes. For example, a process producing telemetry
 * that is running in a container on Kubernetes has a Pod name, it is in a namespace
 * and possibly is part of a Deployment which also has a name. All three of these
 * attributes can be included in the Resource.
 */
export interface Resource {
  /** 
   * Set of attributes that describe the resource.
   * Attribute keys MUST be unique (it is not allowed to have more than one
   * attribute with the same key).
   */
  attributes: KeyValue[];
  
  /** 
   * The number of dropped attributes. If the value is 0, then
   * no attributes were dropped.
   */
  droppedAttributesCount?: number;
  
  /** 
   * Set of entities that participate in this Resource.
   * Note: keys in the references MUST exist in attributes of this message.
   * Status: [Development]
   */
  entityRefs?: EntityRef[];
}
