import {
  setOverlaySessionTargetAdmission,
  setOverlaySessionTargetSuppressed,
} from './overlay-session-authorization.js';
import { win32 } from 'node:path';
import {
  observeOverlayProcesses,
  type OverlayProcessIdentity,
} from './process-observer.js';
import {
  createReShadeLaunchConfig,
  ReShadeOverlayLauncher,
  type ReShadeLaunchConfig,
  type ReShadePathTarget,
  type ReShadeLauncherEvent,
} from './reshade-launcher.js';
import {
  createOverlayProcessPolicy,
  overlayProcessPolicyAllows,
  type OverlayProcessPolicy,
} from './process-policy.js';
import type { OverlaySession } from './overlay-session.js';

/** Fully authorized native selector; path policies use the bounded native grammar. */
export type OverlayEarlyTarget =
  | Readonly<{
      processName: string;
      executablePath?: string;
    }>
  | (ReShadePathTarget &
      Readonly<{ processName?: undefined; executablePath?: undefined }>);
/** Application policy. A best-effort predicate cannot authorize pre-graphics injection. */
export type OverlayTargetPolicy = Readonly<{
  earlyTargets?: readonly OverlayEarlyTarget[];
  /** Serializable allow/deny policy evaluated natively before injection; deny wins. */
  earlyPolicy?: OverlayProcessPolicy;
  acceptBestEffort?: (identity: OverlayProcessIdentity) => boolean;
}>;
/** Snapshot of one retained attachment attempt; cancellation is not target exit. */
export type OverlayManagedTarget = Readonly<{
  pid: number;
  executablePath: string;
  /** Authoritative observer identity, when received; never inferred from authentication. */
  identity?: OverlayProcessIdentity;
  mode: 'early' | 'best-effort';
  status: 'attaching' | 'connected' | 'transport-lost' | 'failed';
  cancelled: boolean;
}>;
/** Controller lifecycle events; only exited carries authoritative OS exit identity. */
export type OverlayTargetWatcherEvent =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'armed'; selector: OverlayEarlyTarget }>
  | Readonly<{
      type: 'attaching' | 'connected' | 'transport-lost' | 'cancelled';
      target: OverlayManagedTarget;
    }>
  | Readonly<{
      type: 'exited';
      target: OverlayManagedTarget;
      identity: OverlayProcessIdentity;
    }>
  | Readonly<{
      type: 'error' | 'discovery-blocked';
      error: Error;
      selector?: OverlayEarlyTarget;
      target?: OverlayManagedTarget;
    }>;
/** Controller configuration, application policy and optional cancellation signal. */
export type OverlayTargetWatcherOptions = OverlayTargetPolicy &
  Readonly<{
    config?: ReShadeLaunchConfig;
    onEvent?: (event: OverlayTargetWatcherEvent) => void;
    signal?: AbortSignal;
  }>;

type Slot = {
  selector: OverlayEarlyTarget;
  enabled: boolean;
  launcher?: ReShadeOverlayLauncher;
  stop?: () => void;
  readiness?: Promise<void>;
  cancelReady?: (error: Error) => void;
  target?: MutableTarget;
  successor?: Slot;
  creationCutoff100ns?: string;
  quiescence?: Promise<boolean>;
  attachStarted?: boolean;
};
type MutableTarget = {
  pid: number;
  executablePath: string;
  identity?: OverlayProcessIdentity;
  mode: 'early' | 'best-effort';
  status: OverlayManagedTarget['status'];
  cancelled: boolean;
  launcher: ReShadeOverlayLauncher;
  stop?: () => void;
  slot?: Slot;
};
const key = (value: string) => value.replace(/\//g, '\\').toLowerCase();
const matches = (s: OverlayEarlyTarget, file: string): boolean =>
  'pathContains' in s
    ? key(file).includes(key(s.pathContains)) &&
      !(s.excludedProcessNames ?? []).some(
        (n) => key(n) === key(win32.basename(file)),
      ) &&
      (s.processPolicy === undefined ||
        overlayProcessPolicyAllows(s.processPolicy, file))
    : key(win32.basename(file)) === key(s.processName) &&
      (s.executablePath === undefined || key(file) === key(s.executablePath));
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Manages future-only attachment around an existing session. Start the session
 * separately, then await ready BEFORE launching targets. One outstanding early
 * name watcher per selector is rearmed only after authoritative OS exit. Native
 * policy watchers stage successors excluding retained incarnations. No automatic retry
 * follows timeout, transport loss, cancellation, or an uncertain injection.
 */
export class OverlayTargetWatcher {
  /** Initial observer, staged best-effort runtime and all early-watcher readiness. */
  public readonly ready: Promise<void>;
  private readonly config: ReShadeLaunchConfig;
  private readonly handlers = new Set<
    (event: OverlayTargetWatcherEvent) => void
  >();
  private readonly slots: Slot[] = [];
  private readonly attempts = new Map<number, MutableTarget>();
  private readonly observed = new Map<number, OverlayProcessIdentity>();
  private readonly exited = new Map<number, OverlayProcessIdentity>();
  private readonly reused = new Set<number>();
  private readonly removers: Array<() => void> = [];
  private observer?: ReturnType<typeof observeOverlayProcesses>;
  private rejectStopped!: (error: Error) => void;
  private readonly stopped = new Promise<never>((_, reject) => {
    this.rejectStopped = reject;
  });
  private resolveObserver!: () => void;
  private rejectObserver!: (error: Error) => void;
  private readonly observerReady = new Promise<void>((resolve, reject) => {
    this.resolveObserver = resolve;
    this.rejectObserver = reject;
  });
  private spare?: ReShadeOverlayLauncher;
  private spareReady?: Promise<void>;
  private policyRevision = 0;
  private discoveryUpdate: Promise<void> = Promise.resolve();
  private earlyPolicy?: OverlayProcessPolicy;
  private bestEffort?: OverlayTargetPolicy['acceptBestEffort'];
  private disposed = false;
  private failed = false;

  constructor(
    private readonly session: OverlaySession,
    options: OverlayTargetWatcherOptions = {},
  ) {
    options.signal?.throwIfAborted();
    // Validate policy before starting observation or native work.
    const selectors = snapshotPolicy(options);
    this.config = options.config ?? createReShadeLaunchConfig();
    if (options.onEvent) this.handlers.add(options.onEvent);
    this.bestEffort = options.acceptBestEffort;
    this.earlyPolicy = options.earlyPolicy
      ? createOverlayProcessPolicy(options.earlyPolicy)
      : undefined;
    for (const selector of selectors)
      this.slots.push({ selector, enabled: true });
    this.removers.push(
      session.onClose(() => this.dispose()),
      session.on('targetTransportLost', ({ pid }) => {
        const target = this.attempts.get(pid);
        if (target && !target.cancelled) {
          target.status = 'transport-lost';
          this.emit({ type: 'transport-lost', target: view(target) });
        }
      }),
      session.on('targetConnected', ({ pid, executablePath }) => {
        // The launcher owns initial authentication/result ordering. This path
        // restores a retained known target after failure or transport recovery.
        const target = this.attempts.get(pid);
        if (
          (target?.status === 'transport-lost' ||
            target?.status === 'failed') &&
          !target.cancelled &&
          key(target.executablePath) === key(executablePath)
        ) {
          target.status = 'connected';
          this.emit({ type: 'connected', target: view(target) });
        }
      }),
    );
    const abort = () => this.dispose();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.removers.push(() =>
      options.signal?.removeEventListener('abort', abort),
    );
    void this.stopped.catch(() => undefined);
    void this.observerReady.catch(() => undefined);
    setOverlaySessionTargetAdmission(this.session, (pid, path, created) =>
      this.admitTarget(pid, path, created),
    );
    this.ready = this.start();
    void this.ready.catch(() => undefined);
    if (options.signal?.aborted) this.dispose();
  }

  /** Immutable current attempts, including uncertain/cancelled targets until OS exit. */
  public get targets(): readonly OverlayManagedTarget[] {
    return Object.freeze([...this.attempts.values()].map(view));
  }

  /** Subscribes without allowing callback errors to alter lifecycle state. */
  public onEvent(
    handler: (event: OverlayTargetWatcherEvent) => void,
  ): () => void {
    if (this.disposed) throw new Error('Target watcher is disposed');
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Applies active authorization synchronously, then settles future discovery.
   * An allowed target retains its launcher and input. Unused native policy
   * watchers are replaced only after checked exit/output-drain proof. Uncertain
   * discovery emits discovery-blocked without cancelling allowed targets or
   * claiming ready; it never authorizes a replacement injection.
   */
  public update(policy: OverlayTargetPolicy): Promise<void> {
    if (this.disposed || this.failed)
      throw new Error('Target watcher is stopped');
    const selectors = snapshotPolicy(policy);
    const revision = ++this.policyRevision;
    this.bestEffort = policy.acceptBestEffort;
    this.earlyPolicy = policy.earlyPolicy
      ? createOverlayProcessPolicy(policy.earlyPolicy)
      : undefined;
    if (!this.bestEffort) {
      this.spare?.dispose();
      this.spare = undefined;
      this.spareReady = undefined;
    }
    for (const slot of this.slots) {
      if (
        slot.enabled &&
        !selectors.some((s) => sameSelector(s, slot.selector))
      ) {
        slot.enabled = false;
        slot.cancelReady?.(
          new Error('Early target policy cancelled before readiness'),
        );
        if (
          !slot.target ||
          !this.targetAllowedByPolicy(slot.target, selectors, policy)
        ) {
          if (slot.target) this.cancelTarget(slot.target);
          else this.stopDiscovery(slot);
        }
      }
    }
    // Discovery selectors and active authorization have independent lifetimes.
    for (const target of this.attempts.values()) {
      if (
        !target.cancelled &&
        !this.targetAllowedByPolicy(target, selectors, policy)
      )
        this.cancelTarget(target);
    }
    const pending = this.discoveryUpdate
      .catch(() => undefined)
      .then(async () => {
        await this.observerReady;
        await Promise.all(
          this.slots
            .filter((slot) => !slot.enabled && slot.quiescence)
            .map((slot) => slot.quiescence),
        );
        if (revision !== this.policyRevision) return;
        if (this.disposed || this.failed)
          throw new Error('Target watcher is stopped');
        let blocked = false;
        for (const selector of selectors) {
          if (
            this.slots.some(
              (slot) => slot.enabled && sameSelector(slot.selector, selector),
            )
          )
            continue;
          if (
            this.slots.some(
              (slot) => !slot.target && overlaps(slot.selector, selector),
            )
          ) {
            blocked = true;
            this.emit({
              type: 'discovery-blocked',
              selector,
              error: new Error(
                'Future discovery remains blocked by an uncertain selector; authorized active targets are retained',
              ),
            });
            continue;
          }
          this.slots.push({ selector, enabled: true });
        }
        try {
          await Promise.all([
            this.prepareSpare(),
            ...this.slots
              .filter((slot) => slot.enabled)
              .map((slot) => this.arm(slot)),
          ]);
        } catch (error) {
          blocked = true;
          this.emit({ type: 'discovery-blocked', error: asError(error) });
        }
        if (!blocked && revision === this.policyRevision)
          this.emit({ type: 'ready' });
      });
    this.discoveryUpdate = pending;
    void pending.catch(() => undefined);
    return pending;
  }

  private stopDiscovery(slot: Slot): void {
    if (slot.quiescence) return;
    const nativePolicy =
      'pathContains' in slot.selector && slot.selector.processPolicy;
    if (nativePolicy) {
      if (!slot.attachStarted) {
        slot.launcher?.dispose();
        slot.quiescence = Promise.resolve(true);
      } else
        slot.quiescence =
          slot.launcher?.quiesceUnselectedPolicyWatcher().catch(() => false) ??
          Promise.resolve(false);
      slot.quiescence = slot.quiescence.then((safe) => {
        if (safe && !slot.target) {
          slot.stop?.();
          const index = this.slots.indexOf(slot);
          if (index >= 0) this.slots.splice(index, 1);
        }
        return safe;
      });
    } else slot.launcher?.dispose();
  }

  /** Cancels policy synchronously, retaining uncertain ownership reservations. */
  public cancel(): Promise<void> {
    return this.update({});
  }

  /** Stops only this controller's work. Does not imply target exit or unload DLLs. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setOverlaySessionTargetAdmission(this.session, () => false);
    this.rejectStopped(new Error('Target watcher disposed before readiness'));
    this.rejectObserver(new Error('Target watcher disposed before readiness'));
    this.observer?.dispose();
    this.spare?.dispose();
    for (const slot of this.slots) {
      slot.cancelReady?.(new Error('Target watcher disposed before readiness'));
      slot.stop?.();
      slot.launcher?.dispose();
    }
    for (const target of this.attempts.values()) {
      target.stop?.();
      target.launcher.dispose();
    }
    for (const stop of this.removers.splice(0)) stop();
    this.handlers.clear();
    this.observed.clear();
    this.exited.clear();
  }

  private async start(): Promise<void> {
    try {
      await Promise.race([this.session.whenReady(), this.stopped]);
      if (this.disposed) throw new Error('Target watcher is disposed');
      this.observer = observeOverlayProcesses({
        runtimeDirectory: this.config.runtimeDirectory,
        onCreated: (identity) => this.created(identity),
        onExited: (identity) => this.processExited(identity),
        onError: (error) => this.fail(error),
      });
      await Promise.race([this.observer.ready, this.stopped]);
      this.resolveObserver();
      if (this.disposed || this.failed)
        throw new Error('Target watcher is stopped');
      await Promise.all([
        this.prepareSpare(),
        ...this.slots.filter((s) => s.enabled).map((s) => this.arm(s)),
      ]);
      this.emit({ type: 'ready' });
    } catch (error) {
      if (!this.disposed) this.fail(asError(error));
      throw error;
    }
  }

  private arm(slot: Slot): Promise<void> {
    if (slot.readiness) return slot.readiness;
    if (!slot.enabled || this.disposed || this.failed)
      return Promise.reject(new Error('Early target is cancelled'));
    const launcher = (slot.launcher = new ReShadeOverlayLauncher(this.config));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    slot.readiness = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    slot.cancelReady = reject;
    void slot.readiness.catch(() => undefined);
    slot.stop = launcher.onEvent((event) => {
      if (this.disposed || slot.launcher !== launcher) return;
      if (event.type === 'injector-watcher-ready' && slot.enabled) {
        slot.creationCutoff100ns = event.creationCutoff100ns;
        resolve();
        this.emit({ type: 'armed', selector: slot.selector });
      }
      this.launcherEvent(launcher, slot, event);
    });
    void launcher
      .prepare()
      .then(() => {
        if (!slot.enabled || this.disposed || this.failed)
          throw new Error('Early target is cancelled');
        const selector =
          'pathContains' in slot.selector &&
          slot.selector.processPolicy &&
          slot.creationCutoff100ns
            ? {
                ...slot.selector,
                policyResume: {
                  creationCutoff100ns: slot.creationCutoff100ns,
                  excludedInstances: [...this.attempts.values()]
                    .filter((t) => t.identity)
                    .map((t) => ({
                      pid: t.pid,
                      creationTime100ns: t.identity!.creationTime100ns,
                    })),
                },
              }
            : slot.selector;
        slot.attachStarted = true;
        return launcher.attach(this.session, selector);
      })
      .catch((error) => {
        reject(asError(error));
        this.attemptFailed(launcher, slot, error);
      });
    return slot.readiness;
  }

  private launcherEvent(
    launcher: ReShadeOverlayLauncher,
    slot: Slot | undefined,
    event: ReShadeLauncherEvent,
  ): void {
    if (
      event.type !== 'injector-returned' &&
      event.type !== 'target-connected' &&
      event.type !== 'target-selected'
    )
      return;
    const pid =
      event.type === 'injector-returned'
        ? event.result.injectorTargetPid
        : event.pid;
    const file =
      event.type === 'injector-returned'
        ? event.result.targetExecutablePath
        : event.type === 'target-selected'
          ? event.executablePath
          : event.path;
    let target = this.attempts.get(pid);
    if (!target && slot) {
      // Never associate an ambiguous recycled PID with an earlier native attempt.
      if (this.reused.has(pid) || !matches(slot.selector, file)) {
        this.fail(
          new Error(
            'Native target identity is ambiguous; attachment retained without retry',
          ),
        );
        return;
      }
      target = {
        pid,
        executablePath: file,
        identity:
          event.type === 'target-selected'
            ? Object.freeze({
                pid,
                executablePath: file,
                creationTime100ns: event.creationTime100ns,
              })
            : (this.observed.get(pid) ?? this.exited.get(pid)),
        mode: 'early',
        status: 'attaching',
        cancelled: !slot.enabled,
        launcher,
        slot,
      };
      if (slot.target && slot.target.pid !== pid) {
        this.fail(new Error('Early watcher selected multiple target PIDs'));
        return;
      }
      slot.target = target;
      this.attempts.set(pid, target);
      this.emit({ type: 'attaching', target: view(target) });
    }
    if (!target || target.launcher !== launcher) return;
    if (
      slot &&
      event.type === 'target-selected' &&
      'pathContains' in slot.selector &&
      slot.selector.processPolicy &&
      slot.enabled &&
      !slot.successor &&
      slot.creationCutoff100ns
    ) {
      const next: Slot = {
        selector: slot.selector,
        enabled: true,
        creationCutoff100ns: slot.creationCutoff100ns,
      };
      slot.successor = next;
      this.slots.push(next);
      void this.arm(next).catch((error) =>
        this.emit({
          type: 'error',
          error: asError(error),
          selector: slot.selector,
        }),
      );
    }

    if (event.type === 'target-connected' && !target.cancelled) {
      target.status = 'connected';
      this.emit({ type: 'connected', target: view(target) });
    }
    const exited = this.exited.get(pid);
    if (
      exited &&
      target.identity?.creationTime100ns === exited.creationTime100ns
    )
      this.retire(target, exited);
  }

  private prepareSpare(): Promise<void> {
    if (!this.bestEffort || this.disposed || this.failed)
      return Promise.resolve();
    if (!this.spare) {
      const launcher = (this.spare = new ReShadeOverlayLauncher(this.config));
      const prepared = launcher.prepare();
      this.spareReady = prepared;
      void prepared.catch(() => {
        if (this.spare === launcher) {
          this.spare = undefined;
          this.spareReady = undefined;
          launcher.dispose();
        }
      });
    }
    return this.spareReady!;
  }

  private created(identity: OverlayProcessIdentity): void {
    if (this.disposed || this.failed) return;
    const reserved = this.slots.some((s) =>
      matches(s.selector, identity.executablePath),
    );
    let accepted = false;
    const revision = this.policyRevision;
    if (!reserved) {
      if (
        this.earlyPolicy?.deny?.length &&
        overlayProcessPolicyAllows(
          { allow: this.earlyPolicy.deny ?? [] },
          identity.executablePath,
        )
      )
        return;
      try {
        accepted = this.bestEffort?.(identity) === true;
      } catch (error) {
        this.emit({ type: 'error', error: asError(error) });
        return;
      }
    }
    if (
      this.disposed ||
      this.failed ||
      revision !== this.policyRevision ||
      (!reserved && !accepted)
    )
      return;
    if (this.observed.has(identity.pid) || this.exited.has(identity.pid))
      this.reused.add(identity.pid);
    this.observed.set(identity.pid, identity);
    if (this.observed.size + this.exited.size > 4096) {
      this.fail(new Error('Managed target observation limit exceeded'));
      return;
    }
    const prior = this.attempts.get(identity.pid);
    if (prior) {
      if (!prior.identity && !this.reused.has(identity.pid))
        prior.identity = identity;
      return;
    }
    // Includes disabled/busy early selectors: no duplicate exact-PID fallback.
    if (reserved || this.reused.has(identity.pid)) return;
    const launcher = this.spare ?? new ReShadeOverlayLauncher(this.config);
    this.spare = undefined;
    this.spareReady = undefined;
    void this.prepareSpare().catch((error) =>
      this.emit({ type: 'error', error: asError(error) }),
    );
    const target: MutableTarget = {
      pid: identity.pid,
      executablePath: identity.executablePath,
      identity,
      mode: 'best-effort',
      status: 'attaching',
      cancelled: false,
      launcher,
    };
    this.attempts.set(identity.pid, target);
    target.stop = launcher.onEvent((event) =>
      this.launcherEvent(launcher, undefined, event),
    );
    this.emit({ type: 'attaching', target: view(target) });
    if (this.disposed || this.failed || target.cancelled) return;
    try {
      void launcher
        .attach(this.session, {
          pid: identity.pid,
          processName: win32.basename(identity.executablePath),
          executablePath: identity.executablePath,
        })
        .catch((error) => this.attemptFailed(launcher, undefined, error));
    } catch (error) {
      this.attemptFailed(launcher, undefined, error);
    }
  }

  private processExited(identity: OverlayProcessIdentity): void {
    const known = this.observed.get(identity.pid);
    if (!known) return;
    if (
      known.creationTime100ns !== identity.creationTime100ns ||
      key(known.executablePath) !== key(identity.executablePath)
    ) {
      // The production observer already verifies this; keep this layer fail-closed too.
      this.fail(new Error('Managed target exit identity mismatch'));
      return;
    }
    this.observed.delete(identity.pid);
    const target = this.attempts.get(identity.pid);
    if (
      target?.identity?.creationTime100ns === identity.creationTime100ns &&
      !this.reused.has(identity.pid)
    )
      this.retire(target, identity);
    else if (
      this.slots.some(
        (s) =>
          s.launcher &&
          !s.target &&
          matches(s.selector, identity.executablePath),
      )
    )
      this.exited.set(identity.pid, identity);
  }

  private retire(
    target: MutableTarget,
    identity: OverlayProcessIdentity,
  ): void {
    if (this.attempts.get(target.pid) !== target) return;
    target.launcher.confirmTargetExited(target.pid);
    setOverlaySessionTargetSuppressed(this.session, target.pid, false);
    target.stop?.();
    target.launcher.dispose();
    this.attempts.delete(target.pid);
    this.observed.delete(target.pid);
    this.exited.delete(target.pid);
    this.reused.delete(target.pid);
    const slot = target.slot;
    if (slot) {
      slot.stop?.();
      slot.launcher = undefined;
      slot.target = undefined;
      slot.readiness = undefined;
      slot.cancelReady = undefined;
      if (!slot.enabled || slot.successor)
        this.slots.splice(this.slots.indexOf(slot), 1);
    }
    this.emit({ type: 'exited', target: view(target), identity });
    if (slot?.enabled && !slot.successor && !this.disposed && !this.failed) {
      void this.arm(slot).catch((error) =>
        this.emit({
          type: 'error',
          error: asError(error),
          selector: slot.selector,
        }),
      );
    }
  }

  private attemptFailed(
    launcher: ReShadeOverlayLauncher,
    slot: Slot | undefined,
    error: unknown,
  ): void {
    if (
      this.disposed ||
      (slot && (slot.launcher !== launcher || !slot.enabled))
    )
      return;
    const target = [...this.attempts.values()].find(
      (t) => t.launcher === launcher,
    );
    if ((!slot && !target) || target?.cancelled) return;
    if (target) target.status = 'failed';
    this.emit({
      type: 'error',
      error: asError(error),
      ...(slot ? { selector: slot.selector } : {}),
      ...(target ? { target: view(target) } : {}),
    });
    // Do not dispose/replace an uncertain attempt or erase its reservation.
  }

  private admitTarget(pid: number, path: string, created?: string): boolean {
    const target = this.attempts.get(pid);
    if (this.disposed || this.failed || !target || target.cancelled)
      return false;
    const canonical = (value: string) => {
      const normalized = win32.normalize(value);
      if (normalized.toLowerCase().startsWith('\\\\?\\unc\\'))
        return '\\\\' + normalized.slice(8);
      if (normalized.startsWith('\\\\?\\')) return normalized.slice(4);
      return normalized;
    };
    if (key(canonical(path)) !== key(canonical(target.executablePath)))
      return false;
    if (this.config.injectorFutureTargets === 2)
      return (
        created !== undefined && target.identity?.creationTime100ns === created
      );
    return (
      created === undefined || target.identity?.creationTime100ns === created
    );
  }

  private targetAllowedByPolicy(
    target: MutableTarget,
    selectors: readonly OverlayEarlyTarget[],
    policy: OverlayTargetPolicy,
  ): boolean {
    if (
      policy.earlyPolicy?.deny?.length &&
      overlayProcessPolicyAllows(
        { allow: policy.earlyPolicy.deny ?? [] },
        target.executablePath,
      )
    )
      return false;
    if (selectors.some((selector) => matches(selector, target.executablePath)))
      return true;
    // Authentication proves the path, not an OS creation identity. Retaining an
    // already authenticated route is not a new injection authorization.
    const identity = target.identity;
    if (!identity) return false;
    try {
      return policy.acceptBestEffort?.(identity) === true;
    } catch (error) {
      this.emit({ type: 'error', error: asError(error), target: view(target) });
      return false;
    }
  }

  private cancelTarget(target: MutableTarget): void {
    if (target.cancelled) return;
    target.cancelled = true;
    setOverlaySessionTargetSuppressed(this.session, target.pid, true);
    target.launcher.dispose();
    this.emit({ type: 'cancelled', target: view(target) });
  }

  private fail(error: Error): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.rejectObserver(error);
    this.rejectStopped(error);
    this.observer?.dispose();
    this.spare?.dispose();
    for (const slot of this.slots) {
      slot.cancelReady?.(error);
      slot.launcher?.dispose();
    }
    for (const target of this.attempts.values()) this.cancelTarget(target);
    this.emit({ type: 'error', error });
  }

  private emit(event: OverlayTargetWatcherEvent): void {
    if (this.disposed) return;
    const snapshot = Object.freeze(event);
    for (const handler of this.handlers) {
      try {
        handler(snapshot);
      } catch {
        /* Observer only. */
      }
    }
  }
}

function view(target: MutableTarget): OverlayManagedTarget {
  return Object.freeze({
    pid: target.pid,
    executablePath: target.executablePath,
    ...(target.identity ? { identity: target.identity } : {}),
    mode: target.mode,
    status: target.status,
    cancelled: target.cancelled,
  });
}
function sameSelector(a: OverlayEarlyTarget, b: OverlayEarlyTarget): boolean {
  if ('pathContains' in a || 'pathContains' in b)
    return (
      'pathContains' in a &&
      'pathContains' in b &&
      key(a.pathContains) === key(b.pathContains) &&
      equivalentNativePolicy(a.processPolicy, b.processPolicy) &&
      JSON.stringify(a.excludedProcessNames ?? []) ===
        JSON.stringify(b.excludedProcessNames ?? [])
    );
  return (
    key(a.processName) === key(b.processName) &&
    key(a.executablePath ?? '') === key(b.executablePath ?? '')
  );
}
// Keep the same native watcher for a provably redundant literal allow. Disposing
// it would create an unproven reservation, then reject restoring the same policy.
// Wildcard inclusion is deliberately not inferred; denies must remain identical.
function equivalentNativePolicy(
  a?: OverlayProcessPolicy,
  b?: OverlayProcessPolicy,
): boolean {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (!a || !b || JSON.stringify(a.deny ?? []) !== JSON.stringify(b.deny ?? []))
    return false;
  const essentialAllows = (policy: OverlayProcessPolicy) =>
    policy.allow.filter((pattern) => {
      if (/[?*]/.test(pattern) || policy.allow.length === 1) return true;
      return !overlayProcessPolicyAllows(
        { allow: policy.allow.filter((other) => other !== pattern) },
        pattern,
      );
    });
  return (
    JSON.stringify(essentialAllows(a)) === JSON.stringify(essentialAllows(b))
  );
}
function overlaps(a: OverlayEarlyTarget, b: OverlayEarlyTarget): boolean {
  // Arbitrary native path policies may intersect. No wildcard inclusion or
  // disjointness is inferred for an unproven retired watcher.
  if ('pathContains' in a || 'pathContains' in b) return true;
  return (
    key(a.processName) === key(b.processName) &&
    (a.executablePath === undefined ||
      b.executablePath === undefined ||
      key(a.executablePath) === key(b.executablePath))
  );
}
function snapshotPolicy(policy: OverlayTargetPolicy): OverlayEarlyTarget[] {
  if (
    policy.acceptBestEffort !== undefined &&
    typeof policy.acceptBestEffort !== 'function'
  )
    throw new TypeError('acceptBestEffort must be a function');
  if (policy.earlyTargets !== undefined && !Array.isArray(policy.earlyTargets))
    throw new TypeError('earlyTargets must be an array');
  const selectors: OverlayEarlyTarget[] = (policy.earlyTargets ?? []).map(
    (s) => {
      if ('pathContains' in s) {
        if (
          typeof s.pathContains !== 'string' ||
          !/[\\/]/.test(s.pathContains) ||
          s.pathContains.includes('\0') ||
          !s.pathContains.trim()
        )
          throw new TypeError('Early path target requires a path fragment');
        const excluded = Object.freeze(
          [...(s.excludedProcessNames ?? [])]
            .map((name) => {
              if (
                typeof name !== 'string' ||
                /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
                !/\.exe$/i.test(name)
              )
                throw new TypeError(
                  'Excluded process names require exact basenames',
                );
              return name;
            })
            .sort(),
        );
        return Object.freeze({
          pathContains: s.pathContains,
          excludedProcessNames: excluded,
          ...(s.processPolicy
            ? { processPolicy: createOverlayProcessPolicy(s.processPolicy) }
            : {}),
        });
      }
      if (
        !s ||
        typeof s.processName !== 'string' ||
        s.processName.length > 260 ||
        s.processName.length <= 4 ||
        s.processName.trim() !== s.processName ||
        /[<>:"/\\|?*\u0000-\u001f]/.test(s.processName) ||
        !/\.exe$/i.test(s.processName)
      )
        throw new TypeError(
          'Early targets require an exact executable basename',
        );
      if (
        s.executablePath !== undefined &&
        (typeof s.executablePath !== 'string' ||
          !win32.isAbsolute(s.executablePath) ||
          /[?*\u0000-\u001f]/.test(s.executablePath) ||
          key(win32.basename(s.executablePath)) !== key(s.processName))
      )
        throw new TypeError(
          'Early targets require an absolute exact executable path matching processName',
        );
      return Object.freeze({
        processName: s.processName,
        ...(s.executablePath === undefined
          ? {}
          : { executablePath: s.executablePath }),
      });
    },
  );
  if (policy.earlyPolicy)
    selectors.push(
      Object.freeze({
        pathContains: '\\',
        processPolicy: createOverlayProcessPolicy(policy.earlyPolicy),
      }),
    );
  for (let i = 0; i < selectors.length; i++)
    if (selectors.slice(0, i).some((s) => overlaps(s, selectors[i])))
      throw new TypeError('Early target selectors must not overlap');
  return selectors;
}
