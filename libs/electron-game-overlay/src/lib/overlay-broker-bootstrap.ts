import { createConnection } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { resolveOverlayBrokerSystemDirectory } from './overlay-broker-windows-os-path.js';

import {
  iterateOverlayBrokerInstallations,
  acquireOverlayBrokerLock,
  type OverlayBrokerInstallationOptions,
} from './overlay-broker-installation.js';
import {
  BrokerPacketDecoder,
  defaultOverlayBrokerPipePath,
  encodeBrokerJsonPacket,
  OVERLAY_BROKER_REQUIRED_CAPABILITIES,
} from './overlay-broker-protocol.js';

/** @internal Total startup budget, including cold cache preparation and service readiness. */
export const DEFAULT_OVERLAY_BROKER_STARTUP_TIMEOUT_MS = 75_000;

/** @internal Bootstrap options; production uses the stable per-account v1 pipe. */
export interface OverlayBrokerBootstrapOptions extends OverlayBrokerInstallationOptions {
  pipePath?: string;
  timeoutMs?: number;
}

/** @internal Mandatory-label SIDs are locale-independent; account/group names and env flags are not privilege proof. */
export function assertOverlayBrokerIntegrityOutput(output: string): void {
  const labels = [
    ...output.matchAll(/(?:^|[\s",])S-1-16-([0-9]+)(?=$|[\s",])/g),
  ];
  if (labels.length !== 1 || labels[0][1] !== '8192') {
    throw new Error(
      'Shared overlay broker requires proven medium Windows integrity; elevated or unknown-integrity launch is unsupported',
    );
  }
}

/** @internal Fail closed before consulting or executing any per-user distribution. No de-elevation is attempted. */
export async function assertOverlayBrokerPrivilege(): Promise<void> {
  if (process.platform !== 'win32') return;
  // The Object Manager SystemRoot link is OS-owned, unlike SystemRoot/PATH
  // environment strings. Never resolve this privileged probe via app paths.
  let output: string;
  try {
    const systemDirectory = await resolveOverlayBrokerSystemDirectory();
    output = await new Promise<string>((resolve, reject) => {
      execFile(
        `${systemDirectory}\\whoami.exe`,
        ['/groups', '/fo', 'csv', '/nh'],
        {
          shell: false,
          windowsHide: true,
          cwd: systemDirectory,
          timeout: 2000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  } catch (error) {
    throw new Error(
      'Unable to prove medium Windows integrity; trusted OS probe failed; shared overlay broker launch is unsupported',
      { cause: error },
    );
  }
  assertOverlayBrokerIntegrityOutput(output);
}

/** @internal Joins an existing compatible owner or starts a validated standalone broker. */
export async function ensureOverlayBrokerRunning(
  options: OverlayBrokerBootstrapOptions = {},
): Promise<void> {
  await assertOverlayBrokerPrivilege();
  const pipePath = options.pipePath ?? defaultOverlayBrokerPipePath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_OVERLAY_BROKER_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError(
      'Bootstrap timeout must be between 1 and 120000 milliseconds',
    );
  const deadline = Date.now() + timeoutMs;
  if (await probeBroker(pipePath, Math.min(1000, timeoutMs))) return;
  const release = await acquireOverlayBrokerLock(
    `launch:${pipePath}`,
    deadline,
  );
  try {
    if (
      await probeBroker(
        pipePath,
        Math.max(1, Math.min(1000, deadline - Date.now())),
      )
    )
      return;

    for await (const candidate of iterateOverlayBrokerInstallations(
      options,
      deadline,
    )) {
      if (Date.now() >= deadline) break;
      // Older v1 bootstraps do not participate in this launch mutex.
      if (
        await probeBroker(
          pipePath,
          Math.max(1, Math.min(1000, deadline - Date.now())),
        )
      )
        return;
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (
          [
            'NODE_OPTIONS',
            'NODE_PATH',
            'ELECTRON_RUN_AS_NODE',
            'ELECTRON_GAME_OVERLAY_BROKER_PIPE',
          ].includes(key.toUpperCase())
        )
          delete env[key];
      }
      env.ELECTRON_GAME_OVERLAY_BROKER_PIPE = pipePath;
      // The broker binds the fixed v1 endpoint exclusively. Starting a
      // coordinator is not native injection: durable target claims remain the
      // authority after process death, never a bootstrap PID journal.
      const child = spawn(candidate.executablePath, [], {
        shell: false,
        cwd: candidate.directory,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      child.once('error', () => {
        if (child.pid === undefined) {
          exited = true;
        }
      });
      child.unref();

      for (;;) {
        if (
          await probeBroker(
            pipePath,
            Math.max(1, Math.min(1000, deadline - Date.now())),
          )
        ) {
          return;
        }
        if (exited) break;
        if (Date.now() >= deadline)
          throw new Error(
            'Overlay broker child is still live or uncertain; refusing replacement after startup timeout',
          );
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, deadline - Date.now())),
        );
      }
    }
    throw new Error('No validated standalone overlay broker could be started');
  } finally {
    // This mutex coordinates startup attempts, not native ownership. A stalled
    // coordinator must not hold it forever; the fixed pipe and durable target
    // claims remain authoritative. Never kill a child or release a target claim.
    await release();
  }
}

async function probeBroker(
  pipePath: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath);
    const decoder = new BrokerPacketDecoder();
    let connected = false;
    let received = 0;
    let settled = false;
    const finish = (result: boolean | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'Overlay broker handshake timed out; endpoint ownership is uncertain',
          ),
        ),
      Math.max(1, timeoutMs),
    );
    socket.once('connect', () => {
      connected = true;
      socket.write(
        encodeBrokerJsonPacket({
          type: 'broker.hello',
          protocolMin: 1,
          protocolMax: 1,
          requiredCapabilities: OVERLAY_BROKER_REQUIRED_CAPABILITIES,
          clientPid: process.pid,
          sdkVersion: 'bootstrap-v1',
        }),
      );
    });
    socket.on('data', (data) => {
      try {
        received += data.length;
        if (received > 64 * 1024)
          throw new Error('Overlay broker handshake exceeds limit');
        for (const packet of decoder.push(data)) {
          const value = packet.kind === 'json' ? packet.value : undefined;
          if (
            typeof value !== 'object' ||
            value === null ||
            !('type' in value) ||
            value.type !== 'broker.welcome' ||
            !('protocolVersion' in value) ||
            value.protocolVersion !== 1 ||
            !('sessionId' in value) ||
            typeof value.sessionId !== 'string' ||
            !value.sessionId ||
            !('brokerPid' in value) ||
            !Number.isSafeInteger(value.brokerPid) ||
            (value.brokerPid as number) <= 0 ||
            (value.brokerPid as number) > 0xffff_ffff ||
            !('capabilities' in value) ||
            !Array.isArray(value.capabilities) ||
            !value.capabilities.every(
              (capability) => typeof capability === 'string',
            ) ||
            !OVERLAY_BROKER_REQUIRED_CAPABILITIES.every((capability) =>
              (value.capabilities as unknown[]).includes(capability),
            )
          ) {
            throw new Error(
              'Existing overlay broker endpoint did not prove v1 compatibility',
            );
          }
          finish(true);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(
        !connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')
          ? false
          : error,
      ),
    );
    socket.once('close', () =>
      finish(
        new Error('Overlay broker closed before completing its v1 handshake'),
      ),
    );
  });
}
