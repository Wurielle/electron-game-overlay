import assert from 'node:assert/strict';
import test from 'node:test';
import { TargetInputInterceptState } from '../src/main/electron/target-input-intercept-state.ts';

test('a disconnected target cannot leave interception effective', () => {
  const state = new TargetInputInterceptState();

  state.connect(1001);
  assert.equal(state.isEffective(true), false);
  assert.equal(state.acknowledge(1001, true), true);
  assert.equal(state.isEffective(true), true);

  state.disconnect(1001);
  assert.equal(state.isEffective(true), false);
  assert.equal(state.acknowledge(1001, true), false);
  assert.equal(state.isEffective(true), false);
});

test('requested interception is effective only after every connected target acknowledges', () => {
  const state = new TargetInputInterceptState();

  state.connect(1001);
  state.connect(1002);
  state.acknowledge(1001, true);
  assert.equal(state.isEffective(true), false);

  state.acknowledge(1002, true);
  assert.equal(state.isEffective(true), true);

  state.disconnect(1002);
  assert.equal(state.isEffective(true), true);
  state.disconnect(1001);
  assert.equal(state.isEffective(true), false);
});

test('release remains pending while any connected target still intercepts', () => {
  const state = new TargetInputInterceptState();

  state.connect(1001);
  state.connect(1002);
  state.acknowledge(1001, true);
  state.acknowledge(1002, true);
  assert.equal(state.isEffective(false), true);

  state.acknowledge(1001, false);
  assert.equal(state.isEffective(false), true);
  state.acknowledge(1002, false);
  assert.equal(state.isEffective(false), false);
});

test('a reconnected transport must acknowledge the session snapshot again', () => {
  const state = new TargetInputInterceptState();

  state.connect(1001);
  state.acknowledge(1001, true);
  assert.equal(state.isEffective(true), true);

  state.connect(1001);
  assert.equal(state.isEffective(true), false);
});
