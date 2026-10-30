import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_INTERCEPT_ACCELERATOR,
  InputInterceptShortcut,
} from '../src/main/electron/input-intercept-shortcut.ts';

test('global interception shortcut registers once, toggles, and disposes once', () => {
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

test('two independent instances share an exclusive registry without stealing shortcuts', () => {
  const callbacks = new Map();
  const attempts = [];
  const registry = {
    register(accelerator, callback) {
      attempts.push(accelerator);
      if (callbacks.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      callbacks.delete(accelerator);
    },
  };
  const toggles = [0, 0];
  const first = new InputInterceptShortcut(registry, () => toggles[0]++);
  const second = new InputInterceptShortcut(registry, () => toggles[1]++);
  try {
    assert.equal(first.register(), true);
    assert.equal(second.register(), true);
    assert.equal(first.accelerator, INPUT_INTERCEPT_ACCELERATOR);
    assert.equal(second.accelerator, 'CommandOrControl+Shift+I');
    assert.equal(second.register(), true);
    assert.deepEqual(attempts, [
      INPUT_INTERCEPT_ACCELERATOR,
      INPUT_INTERCEPT_ACCELERATOR,
      'CommandOrControl+Shift+I',
    ]);
    callbacks.get(first.accelerator)();
    assert.deepEqual(toggles, [1, 0]);
    callbacks.get(second.accelerator)();
    assert.deepEqual(toggles, [1, 1]);
    first.dispose();
    assert.equal(first.accelerator, null);
    assert.equal(callbacks.has(second.accelerator), true);
    callbacks.get(second.accelerator)();
    assert.deepEqual(toggles, [1, 2]);
  } finally {
    first.dispose();
    second.dispose();
  }
  assert.equal(callbacks.size, 0);
});

test('failed registration does not unregister an accelerator owned elsewhere', () => {
  let unregisterCalls = 0;
  const attempts = [];
  const shortcut = new InputInterceptShortcut(
    {
      register: (accelerator) => {
        attempts.push(accelerator);
        return false;
      },
      unregister: () => {
        unregisterCalls += 1;
      },
    },
    () => undefined,
  );

  assert.equal(shortcut.register(), false);
  assert.equal(shortcut.accelerator, null);
  assert.deepEqual(attempts, [
    INPUT_INTERCEPT_ACCELERATOR,
    'CommandOrControl+Shift+I',
  ]);
  shortcut.dispose();
  assert.equal(unregisterCalls, 0);
});
