'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pause = new Int32Array(new SharedArrayBuffer(4));

// Windows may briefly deny replacement while another process opens the old
// snapshot. Keep the complete new file, retry only transient sharing failures,
// and retain the same atomic publication boundary on every attempt.
function publishJsonSnapshot(destination, value) {
  if (!path.isAbsolute(destination)) throw new Error('Snapshot destination must be absolute.');
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, destination); return; }
    catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 39) throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

module.exports = { publishJsonSnapshot };
