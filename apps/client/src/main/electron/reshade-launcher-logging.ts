import type { ReShadeLauncherEvent } from 'electron-game-overlay';

type InjectorStartedEvent = Extract<
  ReShadeLauncherEvent,
  Readonly<{ type: 'injector-started' }>
>;

export type ReShadeLauncherLogger = Readonly<Pick<Console, 'error' | 'log'>>;

export function logReShadeLauncherEvent(
  event: ReShadeLauncherEvent,
  logger: ReShadeLauncherLogger = console,
): void {
  switch (event.type) {
    case 'runtime-staged':
      logger.log(
        `RESHADE_CLIENT_RUNTIME_STAGED directory=${JSON.stringify(event.runDirectory)}`,
      );
      return;
    case 'target-rendezvous-authorized':
      logger.log(
        `RESHADE_CLIENT_TARGET_RENDEZVOUS_AUTHORIZED pid=${event.pid} path=${JSON.stringify(event.discoveryPath)}`,
      );
      return;
    case 'injector-started':
      logger.log(
        `RESHADE_CLIENT_INJECTOR_STARTED target=${JSON.stringify(targetDescriptionFor(event.invocation))} arguments=${JSON.stringify(event.invocation.arguments)}`,
      );
      return;
    case 'injector-watcher-ready':
      logger.log(
        `RESHADE_CLIENT_INJECTOR_WATCHER_READY target=${JSON.stringify(targetDescriptionFor(event.invocation))} arguments=${JSON.stringify(event.invocation.arguments)}`,
      );
      return;
    case 'injector-returned':
      logger.log(
        `RESHADE_CLIENT_INJECTOR_RETURNED target=${JSON.stringify(event.result.processName)}`,
      );
      return;
    case 'injector-failed':
      logger.error(
        `RESHADE_CLIENT_INJECTOR_FAILED target=${JSON.stringify(event.diagnostic.targetLabel ?? 'unknown')} detail=${JSON.stringify(event.diagnostic.message)}`,
      );
      return;
    case 'target-connected':
      logger.log(`RESHADE_CLIENT_TARGET_CONNECTED pid=${event.pid}`);
      return;
    case 'target-disconnected':
      logger.log(`RESHADE_CLIENT_TARGET_DISCONNECTED pid=${event.pid}`);
  }
}

function targetDescriptionFor(
  invocation: InjectorStartedEvent['invocation'],
): string {
  const [firstArgument, pathFragment, ...remainingArguments] =
    invocation.arguments;
  if (firstArgument !== '--path-contains') {
    return firstArgument ?? invocation.targetLabel;
  }

  const excludedProcessNames: string[] = [];
  for (let index = 0; index < remainingArguments.length; index += 1) {
    if (remainingArguments[index] !== '--exclude-name') {
      continue;
    }
    const processName = remainingArguments[index + 1];
    if (processName !== undefined) {
      excludedProcessNames.push(processName);
      index += 1;
    }
  }

  return `path contains ${pathFragment ?? ''}${
    excludedProcessNames.length === 0
      ? ''
      : ` excluding ${excludedProcessNames.join(', ')}`
  }`;
}
