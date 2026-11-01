const { win32 } = require('node:path');

// The OS observer sees unrelated machine processes too. Only the owned image
// is reserved by this acceptance test's early selector.
exports.createEarlyTargetFallbackGuard = (target) => (identity) => {
  if (
    win32.normalize(identity.executablePath).toLowerCase() ===
    win32.normalize(target).toLowerCase()
  ) {
    throw Error('Early discovery must never use exact-PID fallback');
  }
  return false;
};
