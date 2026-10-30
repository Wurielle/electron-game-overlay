const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const {
  acquireLegacyGlobalRendezvousLock,
} = require('../dist/lib/overlay-broker-client.js');

test(
  'the legacy global rendezvous grants exactly one atomic owner',
  { skip: process.platform !== 'win32' },
  async () => {
    const pipePath = `\\\\.\\pipe\\electron-game-overlay-legacy-lock-test-${randomUUID()}`;
    const attempts = await Promise.allSettled([
      acquireLegacyGlobalRendezvousLock(pipePath),
      acquireLegacyGlobalRendezvousLock(pipePath),
    ]);
    const fulfilled = attempts.filter(({ status }) => status === 'fulfilled');
    const rejected = attempts.filter(({ status }) => status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /already owned/);

    fulfilled[0].value();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const releaseReacquired = await acquireLegacyGlobalRendezvousLock(pipePath);
    releaseReacquired();
  },
);
