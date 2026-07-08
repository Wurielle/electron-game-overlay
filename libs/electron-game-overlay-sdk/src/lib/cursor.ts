export function toNativeCursor(type: string) {
  switch (type) {
    case "default":
      return "IDC_ARROW";
    case "pointer":
      return "IDC_HAND";
    case "crosshair":
      return "IDC_CROSS";
    case "text":
      return "IDC_IBEAM";
    case "wait":
      return "IDC_WAIT";
    case "help":
      return "IDC_HELP";
    case "move":
      return "IDC_SIZEALL";
    case "nwse-resize":
      return "IDC_SIZENWSE";
    case "nesw-resize":
      return "IDC_SIZENESW";
    case "ns-resize":
      return "IDC_SIZENS";
    case "ew-resize":
      return "IDC_SIZEWE";
    case "none":
      return "";
    default:
      return "IDC_ARROW";
  }
}
