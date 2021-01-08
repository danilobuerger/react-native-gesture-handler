/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
// @ts-nocheck TODO(TS)
import Hammer from '@egjs/hammerjs';
import { findNodeHandle } from 'react-native';

import { State } from '../State';
import { EventMap } from './constants';
import * as NodeManager from './NodeManager';

// TODO(TS) Replace with HammerInput if https://github.com/DefinitelyTyped/DefinitelyTyped/pull/50438/files is merged
type HammerInputExt = Omit<HammerInput, 'destroy' | 'handler' | 'init'> & {
  maxPointers: number;
  timeStamp: number;
  overallVelocity: number;
  overallVelocityX: number;
  overallVelocityY: number;
};

export type Config = Record<
  | 'minPointers'
  | 'maxPointers'
  | 'minDist'
  | 'maxDist'
  | 'maxDistSq'
  | 'minVelocitySq'
  | 'minDistSq'
  | 'minVelocity'
  | 'failOffsetXStart'
  | 'failOffsetYStart'
  | 'failOffsetXEnd'
  | 'failOffsetYEnd'
  | 'activeOffsetXStart'
  | 'activeOffsetXEnd'
  | 'activeOffsetYStart'
  | 'activeOffsetYEnd',
  number | boolean | null
>;

let gestureInstances = 0;

abstract class GestureHandler {
  protected hasCustomActivationCriteria: boolean;
  protected isGestureRunning = false;
  protected hasGestureFailed = false;
  protected view = null;
  protected hammer: HammerManager | null = null;
  private config = {};
  private pendingGestures: Record<string, this> = {};
  private oldState = State.UNDETERMINED;
  private previousState = State.UNDETERMINED;
  private lastSentState = null;
  private gestureInstance: number;

  abstract get name(): string;

  get id() {
    return `${this.name}${this.gestureInstance}`;
  }

  get isDiscrete() {
    return false;
  }

  get shouldEnableGestureOnSetup() {
    throw new Error('Must override GestureHandler.shouldEnableGestureOnSetup');
  }

  constructor() {
    this.gestureInstance = gestureInstances++;
    this.hasCustomActivationCriteria = false;
  }

  getConfig() {
    return this.config;
  }

  onWaitingEnded(_gesture: this) {}

  removePendingGesture(id: string) {
    delete this.pendingGestures[id];
  }

  addPendingGesture(gesture: this) {
    this.pendingGestures[gesture.id] = gesture;
  }

  isGestureEnabledForEvent() {
    return { success: true };
  }

  get NativeGestureClass() {
    throw new Error('Must override GestureHandler.NativeGestureClass');
  }

  updateHasCustomActivationCriteria(_config: Config) {
    return true;
  }

  clearSelfAsPending = () => {
    if (Array.isArray(this.config.waitFor)) {
      for (const gesture of this.config.waitFor) {
        gesture.removePendingGesture(this.id);
      }
    }
  };

  updateGestureConfig({ enabled = true, ...props }) {
    this.clearSelfAsPending();

    this.config = ensureConfig({ enabled, ...props });
    this.hasCustomActivationCriteria = this.updateHasCustomActivationCriteria(
      this.config
    );
    if (Array.isArray(this.config.waitFor)) {
      for (const gesture of this.config.waitFor) {
        gesture.addPendingGesture(this);
      }
    }

    if (this.hammer) {
      this.sync();
    }
    return this.config;
  }

  destroy = () => {
    this.clearSelfAsPending();

    if (this.hammer) {
      this.hammer.stop(false);
      this.hammer.destroy();
    }
    this.hammer = null;
  };

  isPointInView = ({ x, y }: { x: number; y: number }) => {
    const rect = this.view.getBoundingClientRect();
    const pointerInside =
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    return pointerInside;
  };

  // TODO(TS) change it to `type: keyof typeof EventMap`
  // after https://github.com/DefinitelyTyped/DefinitelyTyped/pull/50433 is merged.
  getState(type: number) {
    return EventMap[type];
  }

  transformEventData(event: HammerInputExt) {
    const { eventType, maxPointers: numberOfPointers } = event;
    // const direction = DirectionMap[ev.direction];
    const changedTouch = event.changedPointers[0];
    const pointerInside = this.isPointInView({
      x: changedTouch.clientX,
      y: changedTouch.clientY,
    });

    const state = this.getState(eventType);
    if (state !== this.previousState) {
      this.oldState = this.previousState;
      this.previousState = state;
    }

    return {
      nativeEvent: {
        numberOfPointers,
        state,
        pointerInside,
        ...this.transformNativeEvent(event),
        // onHandlerStateChange only
        handlerTag: this.handlerTag,
        target: this.ref,
        oldState: this.oldState,
      },
      timeStamp: Date.now(),
    };
  }

  transformNativeEvent(_event: HammerInputExt) {
    return {};
  }

  sendEvent = (nativeEvent: HammerInputExt) => {
    const {
      onGestureHandlerEvent,
      onGestureHandlerStateChange,
    } = this.propsRef.current;

    const event = this.transformEventData(nativeEvent);

    invokeNullableMethod(onGestureHandlerEvent, event);
    if (this.lastSentState !== event.nativeEvent.state) {
      this.lastSentState = event.nativeEvent.state;
      invokeNullableMethod(onGestureHandlerStateChange, event);
    }
  };

  cancelPendingGestures(event: HammerInputExt) {
    for (const gesture of Object.values(this.pendingGestures)) {
      if (gesture && gesture.isGestureRunning) {
        gesture.hasGestureFailed = true;
        gesture.cancelEvent(event);
      }
    }
  }

  notifyPendingGestures() {
    for (const gesture of Object.values(this.pendingGestures)) {
      if (gesture) {
        gesture.onWaitingEnded(this);
      }
    }
  }

  // FIXME event is undefined in runtime when firstly invoked (see Draggable example), check other functions taking event as input
  onGestureEnded(event: HammerInputExt) {
    if (!event) {
      console.log('onGestureEnded', event);
    }
    this.isGestureRunning = false;
    this.cancelPendingGestures(event);
  }

  forceInvalidate(event: HammerInputExt) {
    if (this.isGestureRunning) {
      this.hasGestureFailed = true;
      this.cancelEvent(event);
    }
  }

  cancelEvent(event: HammerInputExt) {
    this.notifyPendingGestures();
    this.sendEvent({
      ...event,
      eventType: Hammer.INPUT_CANCEL,
      isFinal: true,
    });
    this.onGestureEnded(event);
  }

  onRawEvent({ isFirst }: HammerInputExt) {
    if (isFirst) {
      this.hasGestureFailed = false;
    }
  }

  setView(ref, propsRef) {
    if (ref == null) {
      this.destroy();
      this.view = null;
      return;
    }

    this.propsRef = propsRef;
    this.ref = ref;

    this.view = findNodeHandle(ref);
    this.hammer = new Hammer.Manager(this.view);

    this.oldState = State.UNDETERMINED;
    this.previousState = State.UNDETERMINED;
    this.lastSentState = null;

    const { NativeGestureClass } = this;
    const gesture = new NativeGestureClass(this.getHammerConfig());
    this.hammer.add(gesture);

    this.hammer.on('hammer.input', (ev) => {
      if (!this.config.enabled) {
        this.hasGestureFailed = false;
        this.isGestureRunning = false;
        return;
      }

      this.onRawEvent(ev);

      // TODO: Bacon: Check against something other than null
      // The isFirst value is not called when the first rotation is calculated.
      if (this.initialRotation === null && ev.rotation !== 0) {
        this.initialRotation = ev.rotation;
      }
      if (ev.isFinal) {
        // in favor of a willFail otherwise the last frame of the gesture will be captured.
        setTimeout(() => {
          this.initialRotation = null;
          this.hasGestureFailed = false;
        });
      }
    });

    this.setupEvents();
    this.sync();
  }

  setupEvents() {
    // TODO(TS) Hammer types aren't exactly that what we get in runtime
    if (!this.isDiscrete) {
      this.hammer!.on(`${this.name}start`, (event) =>
        this.onStart((event as unknown) as HammerInputExt)
      );
      this.hammer!.on(`${this.name}end ${this.name}cancel`, (event) => {
        this.onGestureEnded((event as unknown) as HammerInputExt);
      });
    }
    this.hammer!.on(this.name, (ev) =>
      this.onGestureActivated((ev as unknown) as HammerInputExt)
    ); // TODO(TS) remove cast after https://github.com/DefinitelyTyped/DefinitelyTyped/pull/50438 is merged
  }

  onStart({ deltaX, deltaY, rotation }) {
    // Reset the state for the next gesture
    this.oldState = State.UNDETERMINED;
    this.previousState = State.UNDETERMINED;
    this.lastSentState = null;

    this.isGestureRunning = true;
    this.__initialX = deltaX;
    this.__initialY = deltaY;
    this.initialRotation = rotation;
  }

  onGestureActivated(ev: HammerInputExt) {
    this.sendEvent(ev);
  }

  onSuccess() {}

  _getPendingGestures() {
    if (Array.isArray(this.config.waitFor) && this.config.waitFor.length) {
      // Get the list of gestures that this gesture is still waiting for.
      // Use `=== false` in case a ref that isn't a gesture handler is used.
      const stillWaiting = this.config.waitFor.filter(
        ({ hasGestureFailed }) => hasGestureFailed === false
      );
      return stillWaiting;
    }
    return [];
  }

  getHammerConfig() {
    const pointers =
      this.config.minPointers === this.config.maxPointers
        ? this.config.minPointers
        : 0;
    return {
      pointers,
    };
  }

  sync = () => {
    const gesture = this.hammer.get(this.name);
    if (!gesture) return;

    const enable = (recognizer, inputData) => {
      if (!this.config.enabled) {
        this.isGestureRunning = false;
        this.hasGestureFailed = false;
        return false;
      }

      // Prevent events before the system is ready.
      if (
        !inputData ||
        !recognizer.options ||
        typeof inputData.maxPointers === 'undefined'
      ) {
        return this.shouldEnableGestureOnSetup;
      }

      if (this.hasGestureFailed) {
        return false;
      }

      if (!this.isDiscrete) {
        if (this.isGestureRunning) {
          return true;
        }
        // The built-in hammer.js "waitFor" doesn't work across multiple views.
        // Only process if there are views to wait for.
        this._stillWaiting = this._getPendingGestures();
        // This gesture should continue waiting.
        if (this._stillWaiting.length) {
          // Check to see if one of the gestures you're waiting for has started.
          // If it has then the gesture should fail.
          for (const gesture of this._stillWaiting) {
            // When the target gesture has started, this gesture must force fail.
            if (!gesture.isDiscrete && gesture.isGestureRunning) {
              this.hasGestureFailed = true;
              this.isGestureRunning = false;
              return false;
            }
          }
          // This gesture shouldn't start until the others have finished.
          return false;
        }
      }

      // Use default behaviour
      if (!this.hasCustomActivationCriteria) {
        return true;
      }

      const deltaRotation =
        this.initialRotation == null
          ? 0
          : inputData.rotation - this.initialRotation;
      const { success, failed } = this.isGestureEnabledForEvent(
        this.getConfig(),
        recognizer,
        {
          ...inputData,
          deltaRotation,
        }
      );

      if (failed) {
        this.simulateCancelEvent(inputData);
        this.hasGestureFailed = true;
      }
      return success;
    };

    const params = this.getHammerConfig();
    gesture.set({ ...params, enable });
  };

  simulateCancelEvent(inputData) {}
}

// TODO(TS) investigate this method
// Used for sending data to a callback or AnimatedEvent
function invokeNullableMethod(
  method:
    | ((event: NativeEvent) => void)
    | { __getHandler: () => (event: NativeEvent) => void }
    | { __nodeConfig: { argMapping: any } },
  event: NativeEvent
) {
  if (method) {
    if (typeof method === 'function') {
      method(event);
    } else {
      // For use with reanimated's AnimatedEvent
      if (
        '__getHandler' in method &&
        typeof method.__getHandler === 'function'
      ) {
        const handler = method.__getHandler();
        invokeNullableMethod(handler, event);
      } else {
        if ('__nodeConfig' in method) {
          const { argMapping } = method.__nodeConfig;
          if (Array.isArray(argMapping)) {
            for (const index in argMapping) {
              const [key, value] = argMapping[index];
              if (key in event.nativeEvent) {
                // @ts-ignore fix method type
                const nativeValue = event.nativeEvent[key];
                if (value && value.setValue) {
                  // Reanimated API
                  value.setValue(nativeValue);
                } else {
                  // RN Animated API
                  method.__nodeConfig.argMapping[index] = [key, nativeValue];
                }
              }
            }
          }
        }
      }
    }
  }
}

// Validate the props
function ensureConfig(config: Config): Required<Config> {
  const props = { ...config };

  // TODO(TS) We use ! to assert that if property is present then value is not empty (null, undefined)
  if ('minDist' in config) {
    props.minDist = config.minDist;
    props.minDistSq = props.minDist! * props.minDist!;
  }
  if ('minVelocity' in config) {
    props.minVelocity = config.minVelocity;
    props.minVelocitySq = props.minVelocity! * props.minVelocity!;
  }
  if ('maxDist' in config) {
    props.maxDist = config.maxDist;
    props.maxDistSq = config.maxDist! * config.maxDist!;
  }
  if ('waitFor' in config) {
    props.waitFor = asArray(config.waitFor)
      .map(({ _handlerTag }: { _handlerTag: number }) =>
        NodeManager.getHandler(_handlerTag)
      )
      .filter((v) => v);
  } else {
    props.waitFor = null;
  }

  const configProps = [
    'minPointers',
    'maxPointers',
    'minDist',
    'maxDist',
    'maxDistSq',
    'minVelocitySq',
    'minDistSq',
    'minVelocity',
    'failOffsetXStart',
    'failOffsetYStart',
    'failOffsetXEnd',
    'failOffsetYEnd',
    'activeOffsetXStart',
    'activeOffsetXEnd',
    'activeOffsetYStart',
    'activeOffsetYEnd',
  ] as const;
  configProps.forEach((prop: typeof configProps[number]) => {
    if (typeof props[prop] === 'undefined') {
      props[prop] = Number.NaN;
    }
  });
  return props as Required<Config>; // TODO(TS) how to convince TS that props are filled?
}

function asArray<T>(value: T | T[]) {
  // TODO(TS) use config.waitFor type
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

export default GestureHandler;
