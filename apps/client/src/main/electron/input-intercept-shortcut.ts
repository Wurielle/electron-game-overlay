export const INPUT_INTERCEPT_ACCELERATOR = 'CommandOrControl+I';

const INPUT_INTERCEPT_ACCELERATORS = [
  INPUT_INTERCEPT_ACCELERATOR,
  'CommandOrControl+Shift+I',
];

export type GlobalShortcutRegistry = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

export class InputInterceptShortcut {
  private selectedAccelerator: string | null = null;

  constructor(
    private readonly registry: GlobalShortcutRegistry,
    private readonly onToggle: () => void,
  ) {}

  public get accelerator(): string | null {
    return this.selectedAccelerator;
  }

  public register(): boolean {
    if (this.selectedAccelerator !== null) return true;
    for (const accelerator of INPUT_INTERCEPT_ACCELERATORS) {
      if (this.registry.register(accelerator, this.onToggle)) {
        this.selectedAccelerator = accelerator;
        return true;
      }
    }
    return false;
  }

  public dispose(): void {
    if (this.selectedAccelerator === null) return;
    this.registry.unregister(this.selectedAccelerator);
    this.selectedAccelerator = null;
  }
}
