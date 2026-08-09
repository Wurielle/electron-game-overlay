import { OverlayBrokerServer } from './overlay-broker-server.js';

export async function runOverlayBrokerServer(
  pipePath = process.env.ELECTRON_GAME_OVERLAY_BROKER_PIPE,
): Promise<OverlayBrokerServer> {
  const server = new OverlayBrokerServer(
    pipePath === undefined || pipePath.length === 0 ? {} : { pipePath },
  );
  await server.start();
  return server;
}

async function main(): Promise<void> {
  const server = await runOverlayBrokerServer();
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void server.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // Concurrent SDK clients may race to launch the singleton. The process
    // that loses the pipe reservation can exit quietly; both clients will
    // retry the stable pipe and connect to the winner.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EADDRINUSE'
    ) {
      process.exit(0);
      return;
    }
    console.error(
      `Electron Game Overlay broker failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  });
}
