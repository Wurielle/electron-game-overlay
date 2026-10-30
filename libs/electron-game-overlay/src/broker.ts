/**
 * Node-only optional broker installation access. Does not import Electron,
 * prepare native providers, or start the broker service.
 * @packageDocumentation
 */
export {
  registerOverlayBrokerInstallation,
  unregisterOverlayBrokerInstallation,
} from './lib/overlay-broker-installation.js';
export type { OverlayBrokerInstallationOptions } from './lib/overlay-broker-installation.js';
