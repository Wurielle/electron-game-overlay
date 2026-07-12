import assert from "node:assert/strict";
import test from "node:test";
import {
  INPUT_INTERCEPT_ACCELERATOR,
  InputInterceptShortcut,
} from "../src/main/electron/input-intercept-shortcut.ts";

test("global interception shortcut registers once, toggles, and disposes once", () => {
  const callbacks = new Map();
  const registrations = [];
  const unregistrations = [];
  const registry = {
    register(accelerator, callback) {
      registrations.push(accelerator);
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      unregistrations.push(accelerator);
      callbacks.delete(accelerator);
    },
  };
  let toggles = 0;
  const shortcut = new InputInterceptShortcut(registry, () => {
    toggles += 1;
  });

  assert.equal(shortcut.register(), true);
  assert.equal(shortcut.register(), true);
  assert.deepEqual(registrations, [INPUT_INTERCEPT_ACCELERATOR]);

  callbacks.get(INPUT_INTERCEPT_ACCELERATOR)();
  assert.equal(toggles, 1);

  shortcut.dispose();
  shortcut.dispose();
  assert.deepEqual(unregistrations, [INPUT_INTERCEPT_ACCELERATOR]);
  assert.equal(callbacks.has(INPUT_INTERCEPT_ACCELERATOR), false);
});

test("failed registration does not unregister an accelerator owned elsewhere", () => {
  let unregisterCalls = 0;
  const shortcut = new InputInterceptShortcut(
    {
      register: () => false,
      unregister: () => {
        unregisterCalls += 1;
      },
    },
    () => undefined
  );

  assert.equal(shortcut.register(), false);
  shortcut.dispose();
  assert.equal(unregisterCalls, 0);
});
