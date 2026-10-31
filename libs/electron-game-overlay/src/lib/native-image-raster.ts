/**
 * The scale of a NativeImage representation is independent of display DPI.
 * New Electron paint/capture images report DIP sizes (truncated), while their
 * bitmap contains the representation's real pixels. Never request a missing
 * representation, resize the image, or infer a square stride from byte length.
 */
export type NativeImageRaster = {
  width: number;
  height: number;
  scaleFactor: number;
  bitmap: Buffer;
};

export function readNativeImageRaster(image: Electron.NativeImage): NativeImageRaster | null {
  const scales = image.getScaleFactors?.() ?? [1];
  if (scales.length === 0) return null;
  if (scales.some(scale => !Number.isFinite(scale) || scale <= 0)) {
    throw new RangeError('Invalid NativeImage representation scale');
  }
  const scaleFactor = Math.max(...scales);
  const dip = image.getSize(scaleFactor);
  if (dip.width <= 0 || dip.height <= 0) return null;
  if (!Number.isSafeInteger(dip.width) || !Number.isSafeInteger(dip.height)) {
    throw new RangeError('Invalid NativeImage dimensions');
  }
  // The representation is known to exist, so this copies pixels without
  // creating or resampling a representation at another scale.
  const bitmap = image.toBitmap({ scaleFactor });
  if (!Buffer.isBuffer(bitmap) || bitmap.byteLength === 0 || bitmap.byteLength % 4 !== 0) {
    throw new RangeError('Invalid NativeImage bitmap length');
  }
  const pixels = bitmap.byteLength / 4;
  const minWidth = Math.ceil(dip.width * scaleFactor);
  const maxWidth = Math.ceil((dip.width + 1) * scaleFactor) - 1;
  const minHeight = Math.ceil(dip.height * scaleFactor);
  const maxHeight = Math.ceil((dip.height + 1) * scaleFactor) - 1;
  const candidates: Array<{width: number; height: number}> = [];
  if (maxWidth - minWidth < 64) {
    for (let width = minWidth; width <= maxWidth; width++) {
      const height = pixels / width;
      if (Number.isSafeInteger(height) && height >= minHeight && height <= maxHeight) candidates.push({width, height});
    }
  }
  let size = candidates.length === 1 ? candidates[0] : undefined;
  if ((!size && candidates.length !== 0) || maxWidth - minWidth >= 64) {
    // Rare fractional-size ambiguity (e.g. swapped non-square pixel extents
    // sharing the same truncated DIP size). PNG's IHDR is exact geometry from
    // this same existing representation; encoded bytes are never published.
    const png = image.toPNG({ scaleFactor });
    if (png.length >= 24 && png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
        png.toString('ascii',12,16) === 'IHDR') {
      size = {width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
    }
  }
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) ||
      size.width < minWidth || size.width > maxWidth || size.height < minHeight || size.height > maxHeight ||
      size.width * size.height !== pixels) {
    throw new RangeError('NativeImage representation dimensions do not match its bitmap');
  }
  return {...size, scaleFactor, bitmap};
}
