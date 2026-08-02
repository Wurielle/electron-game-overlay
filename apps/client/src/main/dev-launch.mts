const GUN_FROG_DEV_MODE = 'gun-frog';
const STEAM_AUTO_ATTACH_FLAG = '--steam-auto-attach';
const DEMO_PRESENTATION_FLAG = '--demo-presentation';

export function buildElectronDevArguments(
  workspaceRoot: string,
  mode: string,
): string[] {
  const arguments_ = [workspaceRoot, '--no-sandbox', '--reshade-overlay'];

  if (mode === GUN_FROG_DEV_MODE) {
    arguments_.push(
      '--reshade-auto-target-process=Gun Frog.exe',
      '--start-overlay-session',
      '--gun-frog-input-proof',
    );
  } else {
    arguments_.push(STEAM_AUTO_ATTACH_FLAG, DEMO_PRESENTATION_FLAG);
  }

  return arguments_;
}
