import type { OverlayBrokerServer } from './overlay-broker-server.js';

export async function runOverlayBrokerServer(
  pipePath = process.env.ELECTRON_GAME_OVERLAY_BROKER_PIPE,
): Promise<OverlayBrokerServer> {
  const { OverlayBrokerServer } =
    require('./overlay-broker-server.js') as typeof import('./overlay-broker-server.js');
  const { prepareStandaloneOverlayNativeProvider } =
    require('./overlay-broker-native-provider.js') as typeof import('./overlay-broker-native-provider.js');
  const nativeRuntimeProvider = await prepareStandaloneOverlayNativeProvider({
    onDiagnostic: (diagnostic) => console.error(diagnostic),
  });
  let server: OverlayBrokerServer | undefined;
  try {
    server = new OverlayBrokerServer({
      ...(pipePath === undefined || pipePath.length === 0 ? {} : { pipePath }),
      ...(nativeRuntimeProvider ? { nativeRuntimeProvider } : {}),
    });
    await server.start();
    return server;
  } catch (error) {
    if (server) await server.stop().catch(() => undefined);
    else nativeRuntimeProvider?.dispose();
    throw error;
  }
}

/** Starts the broker process lifecycle for both Node and standalone launchers. */
export async function runOverlayBrokerMain(): Promise<void> {
  try {
    const { runOverlayBrokerSetup } =
      require('./overlay-broker-setup.js') as typeof import('./overlay-broker-setup.js');
    if (await runOverlayBrokerSetup(process.argv.slice(2))) return;
    const { assertOverlayBrokerPrivilege } =
      require('./overlay-broker-bootstrap.js') as typeof import('./overlay-broker-bootstrap.js');
    await assertOverlayBrokerPrivilege();
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
  } catch (error: unknown) {
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
  }
}

if (require.main === module) {
  void runOverlayBrokerMain();
}
