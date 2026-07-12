export const INPUT_INTERCEPT_ACCELERATOR = "CommandOrControl+I";

export type GlobalShortcutRegistry = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

export class InputInterceptShortcut {
  private registered = false;

  constructor(
    private readonly registry: GlobalShortcutRegistry,
    private readonly onToggle: () => void
  ) {}

  public register(): boolean {
    if (!this.registered) {
      this.registered = this.registry.register(
        INPUT_INTERCEPT_ACCELERATOR,
        this.onToggle
      );
    }
    return this.registered;
  }

  public dispose(): void {
    if (!this.registered) {
      return;
    }
    this.registry.unregister(INPUT_INTERCEPT_ACCELERATOR);
    this.registered = false;
  }
}
