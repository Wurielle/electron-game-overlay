export type HudhookDevBackend = 'd3d11' | 'd3d12';

export function hudhookDevBackend(mode: string): HudhookDevBackend {
  return mode === 'hudhook-d3d12' ? 'd3d12' : 'd3d11';
}

export function buildElectronDevArguments(
  workspaceRoot: string,
  mode: string,
): string[] {
  return [
    workspaceRoot,
    '--no-sandbox',
    '--hudhook-overlay',
    `--hudhook-backend=${hudhookDevBackend(mode)}`,
  ];
}
