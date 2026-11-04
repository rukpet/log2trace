/**
 * A fake element for the input binding: it keeps the listeners it was given,
 * delivers events the test fires (with the field names of the real DOM events),
 * records pointer capture and which events had their default prevented.
 */

import type { InputTarget } from '../../src/kit/input/bind.ts';

/** What a fired event looks like to a listener. */
export interface FakeDomEvent {
  readonly type: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  composedPath?(): unknown[];
  [field: string]: unknown;
}

interface Registration {
  readonly type: string;
  readonly listener: (event: Event) => void;
  readonly options: AddEventListenerOptions | undefined;
}

/** An element-like object with a settable box and a log of everything the binding did to it. */
export class FakeInputTarget implements InputTarget {
  /** Top left of the element's border box in client coordinates. */
  left = 10;
  top = 20;
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 400;
  clientHeight = 300;
  /** Make `setPointerCapture` throw, as the browser does for a pointer that is already gone. */
  refuseCapture = false;

  readonly captured: number[] = [];
  readonly released: number[] = [];
  readonly registrations: Registration[] = [];

  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void {
    this.registrations.push({ type, listener, options });
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const at = this.registrations.findIndex((r) => r.type === type && r.listener === listener);
    if (at >= 0) this.registrations.splice(at, 1);
  }

  getBoundingClientRect(): { readonly left: number; readonly top: number } {
    return { left: this.left, top: this.top };
  }

  setPointerCapture(pointerId: number): void {
    if (this.refuseCapture) throw new Error('NotFoundError: no active pointer with that id');
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId);
  }

  /** How many listeners are registered, for one event type or for all. */
  listenerCount(type?: string): number {
    return type === undefined ? this.registrations.length : this.registrations.filter((r) => r.type === type).length;
  }

  /** Options a listener of this type was registered with. */
  optionsOf(type: string): AddEventListenerOptions | undefined {
    return this.registrations.find((r) => r.type === type)?.options;
  }

  /**
   * Deliver an event to the listeners of its type. Listener errors reach the
   * caller, after every listener has run, as an uncaught error would reach the page.
   *
   * @param type - Event type, such as `pointerdown`.
   * @param fields - The event's fields; `target` defaults to this element.
   */
  fire(type: string, fields: Record<string, unknown> = {}): FakeDomEvent {
    const event: FakeDomEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    let failure: { error: unknown } | null = null;
    for (const registration of [...this.registrations]) {
      if (registration.type !== type) continue;
      try {
        registration.listener(event as unknown as Event);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== null) throw failure.error;
    return event;
  }
}
