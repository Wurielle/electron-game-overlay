const path = require('node:path');

// Entropy boundary for the demo's name generator only; never alter SDK/global randomness.
module.exports = function compileDemoFactory(source, filename) {
  if (!path.normalize(filename).endsWith(path.join('main','utils','utils.ts'))) return source;
  return '"use strict"; const Math = Object.create(globalThis.Math); let fixturePopupSequence = 0; Math.random = () => (fixturePopupSequence++ + 0.5) / 10000;\n' + source;
};
