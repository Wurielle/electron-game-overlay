// Stable Win32 system cursor resource IDs. Zero explicitly hides the cursor.
// Unsupported Chromium shapes (including bitmap/custom) fall back to arrow.
export function electronCursorCode(type: string): number {
  switch (type) {
    case 'none':
      return 0;
    case 'hand':
      return 32649;
    case 'text':
    case 'vertical-text':
      return 32513;
    case 'crosshair':
    case 'cell':
      return 32515;
    case 'wait':
      return 32514;
    case 'progress':
      return 32650;
    case 'help':
      return 32651;
    case 'e-resize':
    case 'w-resize':
    case 'ew-resize':
    case 'col-resize':
      return 32644;
    case 'n-resize':
    case 's-resize':
    case 'ns-resize':
    case 'row-resize':
      return 32645;
    case 'ne-resize':
    case 'sw-resize':
    case 'nesw-resize':
      return 32643;
    case 'nw-resize':
    case 'se-resize':
    case 'nwse-resize':
      return 32642;
    case 'move':
    case 'grab':
    case 'grabbing':
      return 32646;
    case 'nodrop':
    case 'not-allowed':
    case 'ns-no-resize':
    case 'ew-no-resize':
    case 'nesw-no-resize':
    case 'nwse-no-resize':
      return 32648;
    default:
      return 32512;
  }
}
export function isCursorCode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    [
      0, 32512, 32513, 32514, 32515, 32642, 32643, 32644, 32645, 32646, 32648,
      32649, 32650, 32651,
    ].includes(value)
  );
}
