import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import type { BigIntStats, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

export const existingReShadeAddonFileName = 'electron_game_overlay.addon64';
export const existingReShadeAddonMarkerFileName =
  '.electron-game-overlay-addon.json';
export const existingReShadeAddonTransactionFileName =
  '.electron-game-overlay-addon.transaction.json';
export const existingReShadeAddonMarkerKind =
  'electron-game-overlay-reshade-addon';

const MAX_BINARY_SIZE = 64 * 1024 * 1024;
const PE_MACHINE_AMD64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;
const ADDON_ABI_EXPORT_NAME = 'ElectronGameOverlayReShadeAddonAbi';
const ADDON_ABI_VERSION = 1;
const MAX_PE_SECTIONS = 96;
const MAX_PE_EXPORTS = 65_536;
const MAX_PE_EXPORT_NAME_LENGTH = 256;

export interface PrepareExistingReShadeAddonOptions {
  readonly targetExecutablePath: string;
  readonly reshadeModulePath: string;
  readonly addonSourcePath: string;
  readonly managerExecutablePath: string;
  /**
   * Exact effective settings reported by native preflight from the target
   * process. These are required so target environment expansion is never
   * borrowed from Electron.
   */
  readonly targetEffectiveSettings: Readonly<{
    readonly reshadeBasePath: string;
    readonly addonDirectoryPath: string;
    readonly electronGameOverlayAddonDisabled: boolean;
  }>;
}

export interface InspectLoadedOfficialReShadeAddonOptions {
  readonly targetExecutablePath: string;
  readonly reshadeModulePath: string;
  readonly loadedAddonModulePath: string;
  readonly addonSourcePath: string;
  readonly managerExecutablePath: string;
  readonly targetEffectiveSettings: PrepareExistingReShadeAddonOptions['targetEffectiveSettings'];
}

interface ExistingReShadeResultBase {
  readonly targetExecutablePath: string;
  readonly reshadeModulePath: string;
  readonly reshadeModuleSha256: string;
}

interface SupportedExistingReShadeResultBase extends ExistingReShadeResultBase {
  readonly addonSourcePath: string;
  readonly addonSourceSha256: string;
  readonly reshadeBaseDirectoryPath: string;
  readonly reshadeConfigPath: string;
  readonly addonDirectoryPath: string;
  readonly addonDestinationPath: string;
  readonly ownershipMarkerPath: string;
  /**
   * This filesystem-only operation cannot prove whether a running target has
   * already loaded the add-on.
   */
  readonly currentProcessLoadState: 'unknown';
}

export interface DisabledExistingReShadeAddonResult
  extends SupportedExistingReShadeResultBase {
  readonly status: 'disabled-by-user';
  readonly restartRequired: false;
}

export interface InstalledExistingReShadeAddonResult
  extends SupportedExistingReShadeResultBase {
  readonly status: 'installed';
  readonly restartRequired: true;
}

export interface AlreadyCurrentExistingReShadeAddonResult
  extends SupportedExistingReShadeResultBase {
  readonly status: 'already-current';
  readonly restartRequired: true;
}

export interface UpdatedExistingReShadeAddonResult
  extends SupportedExistingReShadeResultBase {
  readonly status: 'updated';
  readonly previousAddonSha256: string;
  readonly restartRequired: true;
}

export type PrepareExistingReShadeAddonResult =
  | DisabledExistingReShadeAddonResult
  | InstalledExistingReShadeAddonResult
  | AlreadyCurrentExistingReShadeAddonResult
  | UpdatedExistingReShadeAddonResult;

export type RemoveOwnedExistingReShadeAddonResult = Readonly<{
  status: 'removed' | 'not-installed';
  targetExecutablePath: string;
  reshadeModulePath: string;
  reshadeModuleSha256: string;
  addonDirectoryPath: string;
  addonDestinationPath: string;
  ownershipMarkerPath: string;
  previousAddonSha256: string | null;
}>;

export type LoadedOfficialReShadeAddonInspectionStatus =
  | 'already-current'
  | 'not-installed'
  | 'update-required'
  | 'foreign-collision'
  | 'owned-tampered'
  | 'transaction-pending';

export type LoadedOfficialReShadeAddonInspectionResult = Readonly<{
  status: LoadedOfficialReShadeAddonInspectionStatus;
  targetExecutablePath: string;
  reshadeModulePath: string;
  reshadeModuleSha256: string;
  loadedAddonModulePath: string;
  addonSourcePath: string;
  addonSourceSha256: string;
  addonDirectoryPath: string;
  addonDestinationPath: string;
  ownershipMarkerPath: string;
  restartRequired: boolean;
}>;

export type ExistingReShadeInstallationErrorCode =
  | 'addon-directory-missing'
  | 'addon-source-invalid'
  | 'configuration-invalid'
  | 'configured-path-escape'
  | 'file-changed'
  | 'foreign-addon-collision'
  | 'manager-failed'
  | 'manager-invalid'
  | 'manager-timeout'
  | 'owned-addon-tampered'
  | 'ownership-marker-invalid'
  | 'path-not-canonical'
  | 'path-reparse-point'
  | 'target-invalid'
  | 'target-module-mismatch'
  | 'target-not-x64'
  | 'reshade-module-invalid'
  | 'reshade-module-not-x64'
  | 'write-race';

export class ExistingReShadeInstallationError extends Error {
  public readonly code: ExistingReShadeInstallationErrorCode;
  public readonly filePath: string | undefined;

  public constructor(
    code: ExistingReShadeInstallationErrorCode,
    message: string,
    filePath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExistingReShadeInstallationError';
    this.code = code;
    this.filePath = filePath;
  }
}

interface VerifiedOpenFile {
  readonly canonicalPath: string;
  readonly handle: FileHandle;
  readonly initialStats: BigIntStats;
}

interface VerifiedBinary {
  readonly canonicalPath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface ResolvedReShadePaths {
  readonly baseDirectoryPath: string;
  readonly configPath: string;
  readonly addonDirectoryPath: string;
  readonly addonDisabled: boolean;
}

const normalizePathForComparison = (filePath: string): string => {
  const normalized = resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const pathsEqual = (left: string, right: string): boolean =>
  normalizePathForComparison(left) === normalizePathForComparison(right);

const isContainedPath = (
  parentPath: string,
  candidatePath: string,
): boolean => {
  const childRelativePath = relative(parentPath, candidatePath);
  return (
    childRelativePath === '' ||
    (!childRelativePath.startsWith(`..${sep}`) &&
      childRelativePath !== '..' &&
      !isAbsolute(childRelativePath))
  );
};

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

const sameFileIdentity = (
  left: Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs'>,
  right: Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs'>,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs;

const assertNoReparseComponents = async (
  absolutePath: string,
  label: string,
): Promise<void> => {
  const parsedPath = parse(absolutePath);
  const components = absolutePath
    .slice(parsedPath.root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let currentPath = parsedPath.root;

  for (const component of components) {
    currentPath = join(currentPath, component);
    let componentStats: Stats;
    try {
      componentStats = await lstat(currentPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }

    if (componentStats.isSymbolicLink()) {
      throw new ExistingReShadeInstallationError(
        'path-reparse-point',
        `${label} must not traverse a symbolic link or directory junction: ${currentPath}`,
        currentPath,
      );
    }
  }
};

const openVerifiedRegularFile = async (
  inputPath: string,
  label: string,
  invalidCode:
    | 'addon-source-invalid'
    | 'manager-invalid'
    | 'reshade-module-invalid'
    | 'target-invalid',
): Promise<VerifiedOpenFile> => {
  const absolutePath = resolve(inputPath);
  await assertNoReparseComponents(absolutePath, label);

  let initialStats: BigIntStats;
  try {
    initialStats = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    throw new ExistingReShadeInstallationError(
      invalidCode,
      `${label} is not an accessible regular file: ${absolutePath}`,
      absolutePath,
      { cause: error },
    );
  }

  if (!initialStats.isFile() || initialStats.isSymbolicLink()) {
    throw new ExistingReShadeInstallationError(
      invalidCode,
      `${label} is not a regular file: ${absolutePath}`,
      absolutePath,
    );
  }

  const canonicalPath = await realpath(absolutePath);
  if (!pathsEqual(canonicalPath, absolutePath)) {
    throw new ExistingReShadeInstallationError(
      'path-not-canonical',
      `${label} resolves through a path alias or reparse point: ${absolutePath}`,
      absolutePath,
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, 'r');
  } catch (error) {
    throw new ExistingReShadeInstallationError(
      invalidCode,
      `${label} could not be opened for inspection: ${canonicalPath}`,
      canonicalPath,
      { cause: error },
    );
  }

  try {
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile() || !sameFileIdentity(initialStats, handleStats)) {
      throw new ExistingReShadeInstallationError(
        'file-changed',
        `${label} changed while it was being opened: ${canonicalPath}`,
        canonicalPath,
      );
    }
  } catch (error) {
    await handle.close();
    throw error;
  }

  return {
    canonicalPath,
    handle,
    initialStats,
  };
};

const verifyOpenFileUnchanged = async (
  file: VerifiedOpenFile,
  label: string,
): Promise<void> => {
  const handleStats = await file.handle.stat({ bigint: true });
  const pathStats = await lstat(file.canonicalPath, { bigint: true });
  const currentCanonicalPath = await realpath(file.canonicalPath);
  if (
    !sameFileIdentity(file.initialStats, handleStats) ||
    !sameFileIdentity(file.initialStats, pathStats) ||
    !pathsEqual(currentCanonicalPath, file.canonicalPath)
  ) {
    throw new ExistingReShadeInstallationError(
      'file-changed',
      `${label} changed while it was being inspected: ${file.canonicalPath}`,
      file.canonicalPath,
    );
  }
};

const readVerifiedFile = async (
  inputPath: string,
  label: string,
  invalidCode:
    | 'addon-source-invalid'
    | 'manager-invalid'
    | 'reshade-module-invalid',
  maxSize: number,
): Promise<VerifiedBinary> => {
  const file = await openVerifiedRegularFile(inputPath, label, invalidCode);
  try {
    if (file.initialStats.size > BigInt(maxSize)) {
      throw new ExistingReShadeInstallationError(
        invalidCode,
        `${label} is larger than the supported inspection limit: ${file.canonicalPath}`,
        file.canonicalPath,
      );
    }
    const bytes = await file.handle.readFile();
    await verifyOpenFileUnchanged(file, label);
    return {
      canonicalPath: file.canonicalPath,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    };
  } finally {
    await file.handle.close();
  }
};

const readExact = async (
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error('Unexpected end of file.');
  }
  return buffer;
};

const assertPeX64Bytes = (
  bytes: Buffer,
  label: string,
  invalidCode:
    | 'addon-source-invalid'
    | 'manager-invalid'
    | 'reshade-module-not-x64',
  filePath: string,
): void => {
  try {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('Missing DOS header.');
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset > bytes.length - 24 ||
      bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000'
    ) {
      throw new Error('Missing PE header.');
    }
    if (bytes.readUInt16LE(peOffset + 4) !== PE_MACHINE_AMD64) {
      throw new Error('PE image is not AMD64.');
    }
  } catch (error) {
    throw new ExistingReShadeInstallationError(
      invalidCode,
      `${label} is not a valid Windows x64 PE image: ${filePath}`,
      filePath,
      { cause: error },
    );
  }
};

interface PeSection {
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawDataOffset: number;
  readonly rawDataSize: number;
}

const checkedRangeEnd = (
  offset: number,
  size: number,
  limit: number,
  description: string,
): number => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > limit ||
    size > limit - offset
  ) {
    throw new Error(`${description} lies outside the PE image.`);
  }
  return offset + size;
};

const assertElectronGameOverlayAddonAbi = (
  bytes: Buffer,
  filePath: string,
): void => {
  try {
    assertPeX64Bytes(
      bytes,
      'Electron Game Overlay add-on source',
      'addon-source-invalid',
      filePath,
    );
    const peOffset = bytes.readUInt32LE(0x3c);
    const fileHeaderOffset = peOffset + 4;
    checkedRangeEnd(fileHeaderOffset, 20, bytes.length, 'PE file header');
    const sectionCount = bytes.readUInt16LE(fileHeaderOffset + 2);
    const optionalHeaderSize = bytes.readUInt16LE(fileHeaderOffset + 16);
    const fileCharacteristics = bytes.readUInt16LE(fileHeaderOffset + 18);
    if (sectionCount < 1 || sectionCount > MAX_PE_SECTIONS) {
      throw new Error('PE section count is outside the supported bound.');
    }
    if ((fileCharacteristics & 0x2000) === 0) {
      throw new Error('PE image is not marked as a DLL.');
    }

    const optionalHeaderOffset = fileHeaderOffset + 20;
    checkedRangeEnd(
      optionalHeaderOffset,
      optionalHeaderSize,
      bytes.length,
      'PE optional header',
    );
    if (
      optionalHeaderSize < 120 ||
      bytes.readUInt16LE(optionalHeaderOffset) !== PE32_PLUS_MAGIC
    ) {
      throw new Error('PE image does not contain a PE32+ optional header.');
    }
    if (bytes.readUInt32LE(optionalHeaderOffset + 108) < 1) {
      throw new Error('PE image does not contain an export directory.');
    }

    const sizeOfHeaders = bytes.readUInt32LE(optionalHeaderOffset + 60);
    const exportDirectoryRva = bytes.readUInt32LE(optionalHeaderOffset + 112);
    const exportDirectorySize = bytes.readUInt32LE(optionalHeaderOffset + 116);
    if (exportDirectoryRva === 0 || exportDirectorySize < 40) {
      throw new Error('PE image does not contain a valid export directory.');
    }

    const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
    checkedRangeEnd(
      sectionTableOffset,
      sectionCount * 40,
      bytes.length,
      'PE section table',
    );
    const sections: PeSection[] = [];
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
      const sectionOffset = sectionTableOffset + sectionIndex * 40;
      sections.push({
        virtualSize: bytes.readUInt32LE(sectionOffset + 8),
        virtualAddress: bytes.readUInt32LE(sectionOffset + 12),
        rawDataSize: bytes.readUInt32LE(sectionOffset + 16),
        rawDataOffset: bytes.readUInt32LE(sectionOffset + 20),
      });
    }

    const rvaToOffset = (
      rva: number,
      size: number,
      description: string,
    ): number => {
      const rvaEnd = checkedRangeEnd(rva, size, 0x1_0000_0000, description);
      if (rva < sizeOfHeaders && rvaEnd <= sizeOfHeaders) {
        checkedRangeEnd(rva, size, bytes.length, description);
        return rva;
      }
      for (const section of sections) {
        const virtualSpan = Math.max(section.virtualSize, section.rawDataSize);
        const sectionVirtualEnd = checkedRangeEnd(
          section.virtualAddress,
          virtualSpan,
          0x1_0000_0000,
          'PE section virtual range',
        );
        if (rva < section.virtualAddress || rvaEnd > sectionVirtualEnd) {
          continue;
        }
        const sectionOffset = rva - section.virtualAddress;
        if (sectionOffset > section.rawDataSize - size) {
          throw new Error(`${description} is not backed by section data.`);
        }
        const rawOffset = section.rawDataOffset + sectionOffset;
        checkedRangeEnd(rawOffset, size, bytes.length, description);
        return rawOffset;
      }
      throw new Error(`${description} does not map to a PE section.`);
    };

    const exportDirectoryOffset = rvaToOffset(
      exportDirectoryRva,
      40,
      'PE export directory',
    );
    const functionCount = bytes.readUInt32LE(exportDirectoryOffset + 20);
    const nameCount = bytes.readUInt32LE(exportDirectoryOffset + 24);
    if (
      functionCount < 1 ||
      functionCount > MAX_PE_EXPORTS ||
      nameCount < 1 ||
      nameCount > MAX_PE_EXPORTS
    ) {
      throw new Error('PE export count is outside the supported bound.');
    }
    const functionTableRva = bytes.readUInt32LE(exportDirectoryOffset + 28);
    const nameTableRva = bytes.readUInt32LE(exportDirectoryOffset + 32);
    const ordinalTableRva = bytes.readUInt32LE(exportDirectoryOffset + 36);
    const functionTableOffset = rvaToOffset(
      functionTableRva,
      functionCount * 4,
      'PE export address table',
    );
    const nameTableOffset = rvaToOffset(
      nameTableRva,
      nameCount * 4,
      'PE export name table',
    );
    const ordinalTableOffset = rvaToOffset(
      ordinalTableRva,
      nameCount * 2,
      'PE export ordinal table',
    );

    const readExportName = (nameRva: number): string => {
      const characters: number[] = [];
      for (
        let characterIndex = 0;
        characterIndex < MAX_PE_EXPORT_NAME_LENGTH;
        characterIndex += 1
      ) {
        const characterOffset = rvaToOffset(
          nameRva + characterIndex,
          1,
          'PE export name',
        );
        const character = bytes[characterOffset];
        if (character === 0) {
          return Buffer.from(characters).toString('ascii');
        }
        if (character === undefined || character > 0x7f) {
          throw new Error('PE export name is not bounded ASCII.');
        }
        characters.push(character);
      }
      throw new Error('PE export name is not NUL terminated.');
    };

    let matchingExportCount = 0;
    let addonAbiRva: number | undefined;
    for (let nameIndex = 0; nameIndex < nameCount; nameIndex += 1) {
      const nameRva = bytes.readUInt32LE(nameTableOffset + nameIndex * 4);
      if (readExportName(nameRva) !== ADDON_ABI_EXPORT_NAME) {
        continue;
      }
      matchingExportCount += 1;
      const ordinal = bytes.readUInt16LE(ordinalTableOffset + nameIndex * 2);
      if (ordinal >= functionCount) {
        throw new Error('Add-on ABI export ordinal is invalid.');
      }
      addonAbiRva = bytes.readUInt32LE(functionTableOffset + ordinal * 4);
    }
    if (matchingExportCount !== 1 || addonAbiRva === undefined) {
      throw new Error(
        `PE image must export exactly one ${ADDON_ABI_EXPORT_NAME} marker.`,
      );
    }

    const exportDirectoryEnd = checkedRangeEnd(
      exportDirectoryRva,
      exportDirectorySize,
      0x1_0000_0000,
      'PE export directory range',
    );
    if (addonAbiRva >= exportDirectoryRva && addonAbiRva < exportDirectoryEnd) {
      throw new Error('Add-on ABI marker must not be a forwarded export.');
    }
    const addonAbiOffset = rvaToOffset(addonAbiRva, 4, 'Add-on ABI marker');
    if (bytes.readUInt32LE(addonAbiOffset) !== ADDON_ABI_VERSION) {
      throw new Error(
        `Add-on ABI marker must contain uint32 value ${ADDON_ABI_VERSION}.`,
      );
    }
  } catch (error) {
    if (error instanceof ExistingReShadeInstallationError) {
      throw error;
    }
    throw new ExistingReShadeInstallationError(
      'addon-source-invalid',
      `Electron Game Overlay add-on source does not contain the required ${ADDON_ABI_EXPORT_NAME} ABI ${ADDON_ABI_VERSION} marker: ${filePath}`,
      filePath,
      { cause: error },
    );
  }
};

const inspectTargetExecutable = async (
  targetExecutablePath: string,
): Promise<string> => {
  const file = await openVerifiedRegularFile(
    targetExecutablePath,
    'Target executable',
    'target-invalid',
  );
  try {
    try {
      if (file.initialStats.size < 64n) {
        throw new Error('Missing DOS header.');
      }
      const dosHeader = await readExact(file.handle, 64, 0);
      if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
        throw new Error('Missing DOS header.');
      }
      const peOffset = dosHeader.readUInt32LE(0x3c);
      if (BigInt(peOffset + 24) > file.initialStats.size) {
        throw new Error('PE header lies outside the file.');
      }
      const peHeader = await readExact(file.handle, 24, peOffset);
      if (peHeader.toString('ascii', 0, 4) !== 'PE\u0000\u0000') {
        throw new Error('Missing PE header.');
      }
      if (peHeader.readUInt16LE(4) !== PE_MACHINE_AMD64) {
        throw new ExistingReShadeInstallationError(
          'target-not-x64',
          `Target executable is not a Windows x64 image: ${file.canonicalPath}`,
          file.canonicalPath,
        );
      }
    } catch (error) {
      if (error instanceof ExistingReShadeInstallationError) {
        throw error;
      }
      throw new ExistingReShadeInstallationError(
        'target-invalid',
        `Target executable is not a valid Windows PE image: ${file.canonicalPath}`,
        file.canonicalPath,
        { cause: error },
      );
    }
    await verifyOpenFileUnchanged(file, 'Target executable');
    return file.canonicalPath;
  } finally {
    await file.handle.close();
  }
};

const requireSafeExistingDirectory = async (
  candidatePath: string,
  containmentRoot: string,
  setting: string,
): Promise<string> => {
  const absoluteCandidatePath = resolve(candidatePath);
  if (!isContainedPath(containmentRoot, absoluteCandidatePath)) {
    throw new ExistingReShadeInstallationError(
      'configured-path-escape',
      `${setting} escapes its allowed ReShade directory: ${absoluteCandidatePath}`,
      absoluteCandidatePath,
    );
  }
  await assertNoReparseComponents(absoluteCandidatePath, setting);

  let directoryStats: Stats;
  try {
    directoryStats = await lstat(absoluteCandidatePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ExistingReShadeInstallationError(
        'addon-directory-missing',
        `${setting} must name an existing directory: ${absoluteCandidatePath}`,
        absoluteCandidatePath,
        { cause: error },
      );
    }
    throw error;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new ExistingReShadeInstallationError(
      'path-reparse-point',
      `${setting} must name a regular directory, not a reparse point: ${absoluteCandidatePath}`,
      absoluteCandidatePath,
    );
  }
  const canonicalCandidatePath = await realpath(absoluteCandidatePath);
  if (
    !pathsEqual(canonicalCandidatePath, absoluteCandidatePath) ||
    !isContainedPath(containmentRoot, canonicalCandidatePath)
  ) {
    throw new ExistingReShadeInstallationError(
      'path-not-canonical',
      `${setting} does not resolve to a contained canonical directory: ${absoluteCandidatePath}`,
      absoluteCandidatePath,
    );
  }
  return canonicalCandidatePath;
};

const resolveReShadePaths = async (
  targetExecutablePath: string,
  reshadeModulePath: string,
  targetEffectiveSettings?: PrepareExistingReShadeAddonOptions['targetEffectiveSettings'],
): Promise<ResolvedReShadePaths> => {
  const moduleDirectoryPath = dirname(reshadeModulePath);
  if (targetEffectiveSettings === undefined) {
    throw new ExistingReShadeInstallationError(
      'configuration-invalid',
      `Target-process ReShade settings are required before managing an existing installation beside ${targetExecutablePath}.`,
      reshadeModulePath,
    );
  }
  const baseDirectoryPath = await requireSafeExistingDirectory(
    targetEffectiveSettings.reshadeBasePath,
    moduleDirectoryPath,
    'target-effective ReShade base path',
  );
  const addonDirectoryPath = await requireSafeExistingDirectory(
    targetEffectiveSettings.addonDirectoryPath,
    baseDirectoryPath,
    'target-effective ReShade add-on directory',
  );
  return {
    baseDirectoryPath,
    configPath: join(baseDirectoryPath, 'ReShade.ini'),
    addonDirectoryPath,
    addonDisabled: targetEffectiveSettings.electronGameOverlayAddonDisabled,
  };
};

const ADDON_MANAGER_RESULT_KIND =
  'electron-game-overlay-reshade-addon-manager-result';
const ADDON_MANAGER_TIMEOUT_MS = 30_000;
const MAX_ADDON_MANAGER_OUTPUT_BYTES = 64 * 1024;
const UPPER_SHA256_PATTERN = /^[0-9A-F]{64}$/u;

type NativeAddonManagerOperation = 'prepare' | 'inspect' | 'remove';
type NativeAddonManagerPrepareStatus =
  | 'installed'
  | 'already-current'
  | 'updated';
type NativeAddonManagerRemoveStatus = 'removed' | 'not-installed';
type NativeAddonManagerInspectStatus =
  | 'already-current'
  | 'not-installed'
  | 'update-required'
  | 'foreign-collision'
  | 'owned-tampered'
  | 'transaction-pending';
type NativeAddonManagerSuccessStatus =
  | NativeAddonManagerPrepareStatus
  | NativeAddonManagerRemoveStatus
  | NativeAddonManagerInspectStatus;

type NativeAddonManagerSuccess = Readonly<{
  schemaVersion: 1;
  kind: typeof ADDON_MANAGER_RESULT_KIND;
  operation: NativeAddonManagerOperation;
  status: NativeAddonManagerSuccessStatus;
  addonPath: string;
  markerPath: string;
  addonSha256: string | null;
  expectedAddonSha256: string | null;
  previousAddonSha256: string | null;
  reshadeModulePath: string;
  reshadeModuleSha256: string;
  recoveredTransaction: boolean;
  restartRequired: boolean;
}>;

type NativeAddonManagerErrorRecord = Readonly<{
  schemaVersion: 1;
  kind: typeof ADDON_MANAGER_RESULT_KIND;
  operation: NativeAddonManagerOperation | null;
  status: 'error';
  code: string;
  message: string;
  windowsError: number | null;
}>;

const hasExactObjectKeys = (
  candidate: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(candidate).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
};

const parseAddonManagerRecord = (
  stdout: string,
  expectedOperation: NativeAddonManagerOperation,
):
  | Readonly<{ kind: 'success'; result: NativeAddonManagerSuccess }>
  | Readonly<{ kind: 'error'; result: NativeAddonManagerErrorRecord }>
  | Readonly<{ kind: 'invalid'; detail: string }> => {
  if (
    Buffer.byteLength(stdout, 'utf8') > MAX_ADDON_MANAGER_OUTPUT_BYTES ||
    !/^[^\r\n]*\r?\n$/u.test(stdout)
  ) {
    return {
      kind: 'invalid',
      detail: 'manager stdout was not exactly one bounded JSON line',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(/\r?\n$/u, ''));
  } catch {
    return {
      kind: 'invalid',
      detail: 'manager stdout was not valid JSON',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'invalid',
      detail: 'manager result was not an object',
    };
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== ADDON_MANAGER_RESULT_KIND
  ) {
    return {
      kind: 'invalid',
      detail: 'manager result did not match schema version 1',
    };
  }

  if (candidate.status === 'error') {
    if (
      !hasExactObjectKeys(candidate, [
        'code',
        'kind',
        'message',
        'operation',
        'schemaVersion',
        'status',
        'windowsError',
      ]) ||
      (candidate.operation !== null &&
        candidate.operation !== expectedOperation) ||
      typeof candidate.code !== 'string' ||
      candidate.code.length === 0 ||
      typeof candidate.message !== 'string' ||
      candidate.message.length === 0 ||
      (candidate.windowsError !== null &&
        (!Number.isSafeInteger(candidate.windowsError) ||
          (candidate.windowsError as number) <= 0 ||
          (candidate.windowsError as number) > 0xffffffff))
    ) {
      return {
        kind: 'invalid',
        detail: 'manager error did not match schema version 1',
      };
    }
    return {
      kind: 'error',
      result: candidate as NativeAddonManagerErrorRecord,
    };
  }

  if (
    !hasExactObjectKeys(candidate, [
      'addonPath',
      'addonSha256',
      'expectedAddonSha256',
      'kind',
      'markerPath',
      'operation',
      'previousAddonSha256',
      'recoveredTransaction',
      'reshadeModulePath',
      'reshadeModuleSha256',
      'restartRequired',
      'schemaVersion',
      'status',
    ]) ||
    candidate.operation !== expectedOperation ||
    (candidate.status !== 'installed' &&
      candidate.status !== 'already-current' &&
      candidate.status !== 'updated' &&
      candidate.status !== 'removed' &&
      candidate.status !== 'not-installed' &&
      candidate.status !== 'update-required' &&
      candidate.status !== 'foreign-collision' &&
      candidate.status !== 'owned-tampered' &&
      candidate.status !== 'transaction-pending') ||
    typeof candidate.addonPath !== 'string' ||
    !isAbsolute(candidate.addonPath) ||
    candidate.addonPath.includes('\0') ||
    typeof candidate.markerPath !== 'string' ||
    !isAbsolute(candidate.markerPath) ||
    candidate.markerPath.includes('\0') ||
    (candidate.addonSha256 !== null &&
      (typeof candidate.addonSha256 !== 'string' ||
        !UPPER_SHA256_PATTERN.test(candidate.addonSha256))) ||
    (candidate.expectedAddonSha256 !== null &&
      (typeof candidate.expectedAddonSha256 !== 'string' ||
        !UPPER_SHA256_PATTERN.test(candidate.expectedAddonSha256))) ||
    (candidate.previousAddonSha256 !== null &&
      (typeof candidate.previousAddonSha256 !== 'string' ||
        !UPPER_SHA256_PATTERN.test(candidate.previousAddonSha256))) ||
    typeof candidate.reshadeModulePath !== 'string' ||
    !isAbsolute(candidate.reshadeModulePath) ||
    candidate.reshadeModulePath.includes('\0') ||
    typeof candidate.reshadeModuleSha256 !== 'string' ||
    !UPPER_SHA256_PATTERN.test(candidate.reshadeModuleSha256) ||
    typeof candidate.recoveredTransaction !== 'boolean' ||
    typeof candidate.restartRequired !== 'boolean'
  ) {
    return {
      kind: 'invalid',
      detail: 'manager success did not match schema version 1',
    };
  }

  const status = candidate.status;
  const addonSha256 = candidate.addonSha256;
  const expectedAddonSha256 = candidate.expectedAddonSha256;
  const previousAddonSha256 = candidate.previousAddonSha256;
  const recoveredTransaction = candidate.recoveredTransaction;
  const restartRequired = candidate.restartRequired;
  let validStatusInvariant: boolean;
  if (expectedOperation === 'prepare') {
    validStatusInvariant =
      ((status === 'installed' || status === 'already-current') &&
        addonSha256 === expectedAddonSha256 &&
        expectedAddonSha256 !== null &&
        previousAddonSha256 === null &&
        restartRequired === true) ||
      (status === 'updated' &&
        addonSha256 === expectedAddonSha256 &&
        expectedAddonSha256 !== null &&
        previousAddonSha256 !== null &&
        previousAddonSha256 !== expectedAddonSha256 &&
        restartRequired === true);
  } else if (expectedOperation === 'inspect') {
    validStatusInvariant =
      recoveredTransaction === false &&
      expectedAddonSha256 !== null &&
      previousAddonSha256 === null &&
      ((status === 'already-current' &&
        addonSha256 === expectedAddonSha256 &&
        restartRequired === false) ||
        (status === 'not-installed' &&
          addonSha256 === null &&
          restartRequired === false) ||
        (status === 'update-required' &&
          addonSha256 !== null &&
          addonSha256 !== expectedAddonSha256 &&
          restartRequired === true) ||
        (status === 'foreign-collision' && restartRequired === false) ||
        (status === 'owned-tampered' &&
          addonSha256 !== null &&
          restartRequired === false) ||
        (status === 'transaction-pending' &&
          addonSha256 === null &&
          restartRequired === true));
  } else {
    validStatusInvariant =
      expectedAddonSha256 === null &&
      addonSha256 === null &&
      restartRequired === true &&
      ((status === 'removed' && previousAddonSha256 !== null) ||
        (status === 'not-installed' && previousAddonSha256 === null));
  }
  if (!validStatusInvariant) {
    return {
      kind: 'invalid',
      detail:
        'manager success fields contradicted its operation and status invariants',
    };
  }
  return {
    kind: 'success',
    result: candidate as NativeAddonManagerSuccess,
  };
};

const managerErrorCode = (
  nativeCode: string,
): ExistingReShadeInstallationErrorCode => {
  switch (nativeCode) {
    case 'foreign-addon-collision':
      return 'foreign-addon-collision';
    case 'owned-addon-tampered':
      return 'owned-addon-tampered';
    case 'ownership-marker-invalid':
      return 'ownership-marker-invalid';
    case 'path-not-canonical':
      return 'path-not-canonical';
    case 'path-reparse-point':
    case 'path-identity-invalid':
      return 'path-reparse-point';
    case 'source-changed':
    case 'reshade-module-changed':
      return 'file-changed';
    case 'write-race':
    case 'transaction-conflict':
    case 'transaction-invalid':
    case 'transaction-state-invalid':
    case 'transaction-runtime-mismatch':
      return 'write-race';
    case 'invalid-request':
      return 'manager-invalid';
    default:
      return 'manager-failed';
  }
};

const runNativeAddonManager = async (
  operation: NativeAddonManagerOperation,
  managerExecutablePath: string,
  addonDirectoryPath: string,
  addonSourcePath: string | null,
  addonSourceSha256: string | null,
  reshadeModulePath: string,
  reshadeModuleSha256: string,
): Promise<NativeAddonManagerSuccess> => {
  const managerExecutable = await readVerifiedFile(
    managerExecutablePath,
    'Electron Game Overlay ReShade add-on manager',
    'manager-invalid',
    MAX_BINARY_SIZE,
  );
  assertPeX64Bytes(
    managerExecutable.bytes,
    'Electron Game Overlay ReShade add-on manager',
    'manager-invalid',
    managerExecutable.canonicalPath,
  );

  if (
    operation !== 'remove' &&
    (addonSourcePath === null || addonSourceSha256 === null)
  ) {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      `The native ReShade add-on manager ${operation} operation requires an exact staged add-on source.`,
      managerExecutable.canonicalPath,
    );
  }
  const managerArguments = [
    operation,
    '--directory',
    addonDirectoryPath,
    ...(operation === 'remove'
      ? []
      : ['--source', addonSourcePath!, '--source-sha256', addonSourceSha256!]),
    '--reshade-module',
    reshadeModulePath,
    '--reshade-module-sha256',
    reshadeModuleSha256,
  ];

  const execution = await new Promise<{
    error:
      | (Error & { code?: unknown; killed?: unknown; signal?: unknown })
      | null;
    stdout: string;
    stderr: string;
  }>((resolveExecution) => {
    execFile(
      managerExecutable.canonicalPath,
      managerArguments,
      {
        windowsHide: true,
        timeout: ADDON_MANAGER_TIMEOUT_MS,
        maxBuffer: MAX_ADDON_MANAGER_OUTPUT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        resolveExecution({
          error,
          stdout,
          stderr,
        });
      },
    );
  });

  if (
    execution.error?.killed === true ||
    execution.error?.signal != null ||
    execution.error?.code === 'ETIMEDOUT'
  ) {
    throw new ExistingReShadeInstallationError(
      'manager-timeout',
      `The native ReShade add-on manager did not complete within ${ADDON_MANAGER_TIMEOUT_MS}ms.`,
      managerExecutable.canonicalPath,
      { cause: execution.error },
    );
  }
  if (execution.stderr !== '') {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      'The native ReShade add-on manager emitted unexpected stderr output.',
      managerExecutable.canonicalPath,
      execution.error === null ? undefined : { cause: execution.error },
    );
  }

  const parsed = parseAddonManagerRecord(execution.stdout, operation);
  if (parsed.kind === 'invalid') {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      `The native ReShade add-on manager protocol was invalid: ${parsed.detail}.`,
      managerExecutable.canonicalPath,
      execution.error === null ? undefined : { cause: execution.error },
    );
  }
  if (parsed.kind === 'error') {
    if (execution.error === null) {
      throw new ExistingReShadeInstallationError(
        'manager-invalid',
        'The native ReShade add-on manager reported an error with a zero exit code.',
        managerExecutable.canonicalPath,
      );
    }
    if (
      typeof execution.error.code !== 'number' ||
      ![2, 3, 4, 5].includes(execution.error.code)
    ) {
      throw new ExistingReShadeInstallationError(
        'manager-invalid',
        'The native ReShade add-on manager used an unexpected error exit code.',
        managerExecutable.canonicalPath,
        { cause: execution.error },
      );
    }
    throw new ExistingReShadeInstallationError(
      managerErrorCode(parsed.result.code),
      `The native ReShade add-on manager preserved the installation: ${parsed.result.message}`,
      addonDirectoryPath,
      { cause: execution.error },
    );
  }
  if (execution.error !== null) {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      'The native ReShade add-on manager returned success metadata with a nonzero exit code.',
      managerExecutable.canonicalPath,
      { cause: execution.error },
    );
  }
  if (
    parsed.result.operation !== operation ||
    !pathsEqual(
      parsed.result.addonPath,
      join(addonDirectoryPath, existingReShadeAddonFileName),
    ) ||
    !pathsEqual(
      parsed.result.markerPath,
      join(addonDirectoryPath, existingReShadeAddonMarkerFileName),
    ) ||
    parsed.result.expectedAddonSha256 !== addonSourceSha256 ||
    !pathsEqual(parsed.result.reshadeModulePath, reshadeModulePath) ||
    parsed.result.reshadeModuleSha256 !== reshadeModuleSha256
  ) {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      'The native ReShade add-on manager returned metadata for a different request.',
      managerExecutable.canonicalPath,
    );
  }
  return parsed.result;
};

/**
 * Safely prepares Electron Game Overlay for a target-local ReShade host.
 * Compatibility is negotiated by the loaded add-on through ReShade's public
 * registration and ImGui-table APIs rather than by product version or hash.
 */
export const prepareExistingReShadeAddon = async (
  options: PrepareExistingReShadeAddonOptions,
): Promise<PrepareExistingReShadeAddonResult> => {
  const targetExecutablePath = await inspectTargetExecutable(
    options.targetExecutablePath,
  );
  const reshadeModule = await readVerifiedFile(
    options.reshadeModulePath,
    'ReShade module',
    'reshade-module-invalid',
    MAX_BINARY_SIZE,
  );
  assertPeX64Bytes(
    reshadeModule.bytes,
    'ReShade module',
    'reshade-module-not-x64',
    reshadeModule.canonicalPath,
  );
  if (
    !pathsEqual(
      dirname(targetExecutablePath),
      dirname(reshadeModule.canonicalPath),
    )
  ) {
    throw new ExistingReShadeInstallationError(
      'target-module-mismatch',
      `ReShade module must be installed beside the target executable before add-on preparation is allowed: ${reshadeModule.canonicalPath}`,
      reshadeModule.canonicalPath,
    );
  }

  const commonResult = {
    targetExecutablePath,
    reshadeModulePath: reshadeModule.canonicalPath,
    reshadeModuleSha256: reshadeModule.sha256,
  } as const;

  const addonSource = await readVerifiedFile(
    options.addonSourcePath,
    'Electron Game Overlay add-on source',
    'addon-source-invalid',
    MAX_BINARY_SIZE,
  );
  assertElectronGameOverlayAddonAbi(
    addonSource.bytes,
    addonSource.canonicalPath,
  );

  const reshadePaths = await resolveReShadePaths(
    targetExecutablePath,
    reshadeModule.canonicalPath,
    options.targetEffectiveSettings,
  );
  const addonDirectoryPath = reshadePaths.addonDirectoryPath;
  const addonDestinationPath = join(
    addonDirectoryPath,
    existingReShadeAddonFileName,
  );
  const ownershipMarkerPath = join(
    addonDirectoryPath,
    existingReShadeAddonMarkerFileName,
  );
  if (
    pathsEqual(addonSource.canonicalPath, addonDestinationPath) ||
    pathsEqual(addonSource.canonicalPath, ownershipMarkerPath)
  ) {
    throw new ExistingReShadeInstallationError(
      'addon-source-invalid',
      `Add-on source must be separate from the managed destination: ${addonSource.canonicalPath}`,
      addonSource.canonicalPath,
    );
  }

  const supportedResult = {
    ...commonResult,
    addonSourcePath: addonSource.canonicalPath,
    addonSourceSha256: addonSource.sha256,
    reshadeBaseDirectoryPath: reshadePaths.baseDirectoryPath,
    reshadeConfigPath: reshadePaths.configPath,
    addonDirectoryPath,
    addonDestinationPath,
    ownershipMarkerPath,
    currentProcessLoadState: 'unknown',
  } as const;
  if (reshadePaths.addonDisabled) {
    return {
      ...supportedResult,
      status: 'disabled-by-user',
      restartRequired: false,
    };
  }
  const managerResult = await runNativeAddonManager(
    'prepare',
    options.managerExecutablePath,
    addonDirectoryPath,
    addonSource.canonicalPath,
    addonSource.sha256,
    reshadeModule.canonicalPath,
    reshadeModule.sha256,
  );
  if (
    managerResult.status !== 'installed' &&
    managerResult.status !== 'already-current' &&
    managerResult.status !== 'updated'
  ) {
    throw new ExistingReShadeInstallationError(
      managerResult.status === 'owned-tampered'
        ? 'owned-addon-tampered'
        : managerResult.status === 'foreign-collision'
          ? 'foreign-addon-collision'
          : 'write-race',
      `The native ReShade add-on manager preserved an unsafe state (${managerResult.status}).`,
      addonDirectoryPath,
    );
  }
  if (managerResult.status === 'updated') {
    if (managerResult.previousAddonSha256 === null) {
      throw new ExistingReShadeInstallationError(
        'manager-invalid',
        'The native ReShade add-on manager omitted the previous add-on hash for an update.',
        options.managerExecutablePath,
      );
    }
    return {
      ...supportedResult,
      status: 'updated',
      previousAddonSha256: managerResult.previousAddonSha256,
      restartRequired: true,
    };
  }
  return {
    ...supportedResult,
    status: managerResult.status,
    restartRequired: true,
  };
};

/**
 * Removes only a manager-owned Electron Game Overlay add-on pair.
 * Foreign, partial, tampered, or ambiguously owned reserved paths are preserved
 * by the native manager.
 */
export const removeOwnedExistingReShadeAddon = async (
  options: PrepareExistingReShadeAddonOptions,
): Promise<RemoveOwnedExistingReShadeAddonResult> => {
  const targetExecutablePath = await inspectTargetExecutable(
    options.targetExecutablePath,
  );
  const reshadeModule = await readVerifiedFile(
    options.reshadeModulePath,
    'ReShade module',
    'reshade-module-invalid',
    MAX_BINARY_SIZE,
  );
  assertPeX64Bytes(
    reshadeModule.bytes,
    'ReShade module',
    'reshade-module-not-x64',
    reshadeModule.canonicalPath,
  );
  if (
    !pathsEqual(
      dirname(targetExecutablePath),
      dirname(reshadeModule.canonicalPath),
    )
  ) {
    throw new ExistingReShadeInstallationError(
      'target-module-mismatch',
      'The ReShade module moved away from the exact target before owned add-on removal.',
      reshadeModule.canonicalPath,
    );
  }

  const reshadePaths = await resolveReShadePaths(
    targetExecutablePath,
    reshadeModule.canonicalPath,
    options.targetEffectiveSettings,
  );
  const managerResult = await runNativeAddonManager(
    'remove',
    options.managerExecutablePath,
    reshadePaths.addonDirectoryPath,
    null,
    null,
    reshadeModule.canonicalPath,
    reshadeModule.sha256,
  );
  if (
    managerResult.status !== 'removed' &&
    managerResult.status !== 'not-installed'
  ) {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      `The native ReShade add-on manager returned an invalid removal status (${managerResult.status}).`,
      options.managerExecutablePath,
    );
  }
  return {
    status: managerResult.status,
    targetExecutablePath,
    reshadeModulePath: reshadeModule.canonicalPath,
    reshadeModuleSha256: reshadeModule.sha256,
    addonDirectoryPath: reshadePaths.addonDirectoryPath,
    addonDestinationPath: managerResult.addonPath,
    ownershipMarkerPath: managerResult.markerPath,
    previousAddonSha256: managerResult.previousAddonSha256,
  };
};

/**
 * Confirms that a loaded official-host add-on is the exact currently staged,
 * manager-owned generation. This operation is read-only and never recovers or
 * updates a pending transaction in a running target.
 */
export const inspectLoadedOfficialReShadeAddon = async (
  options: InspectLoadedOfficialReShadeAddonOptions,
): Promise<LoadedOfficialReShadeAddonInspectionResult> => {
  const targetExecutablePath = await inspectTargetExecutable(
    options.targetExecutablePath,
  );
  const reshadeModule = await readVerifiedFile(
    options.reshadeModulePath,
    'ReShade module',
    'reshade-module-invalid',
    MAX_BINARY_SIZE,
  );
  assertPeX64Bytes(
    reshadeModule.bytes,
    'ReShade module',
    'reshade-module-not-x64',
    reshadeModule.canonicalPath,
  );
  if (
    !pathsEqual(
      dirname(targetExecutablePath),
      dirname(reshadeModule.canonicalPath),
    )
  ) {
    throw new ExistingReShadeInstallationError(
      'target-module-mismatch',
      'The loaded official ReShade host no longer matches the recognized target-local runtime.',
      reshadeModule.canonicalPath,
    );
  }

  const addonSource = await readVerifiedFile(
    options.addonSourcePath,
    'Electron Game Overlay add-on source',
    'addon-source-invalid',
    MAX_BINARY_SIZE,
  );
  assertElectronGameOverlayAddonAbi(
    addonSource.bytes,
    addonSource.canonicalPath,
  );
  const loadedAddon = await readVerifiedFile(
    options.loadedAddonModulePath,
    'Loaded Electron Game Overlay ReShade add-on',
    'addon-source-invalid',
    MAX_BINARY_SIZE,
  );
  if (
    !pathsEqual(
      loadedAddon.canonicalPath,
      resolve(dirname(loadedAddon.canonicalPath), existingReShadeAddonFileName),
    )
  ) {
    throw new ExistingReShadeInstallationError(
      'foreign-addon-collision',
      'The loaded official ReShade add-on does not use the reserved managed filename.',
      loadedAddon.canonicalPath,
    );
  }

  const effectivePaths = await resolveReShadePaths(
    targetExecutablePath,
    reshadeModule.canonicalPath,
    options.targetEffectiveSettings,
  );
  if (effectivePaths.addonDisabled) {
    throw new ExistingReShadeInstallationError(
      'configuration-invalid',
      'The loaded Electron Game Overlay add-on is disabled by the target-effective ReShade configuration.',
      loadedAddon.canonicalPath,
    );
  }
  const expectedLoadedAddonPath = join(
    effectivePaths.addonDirectoryPath,
    existingReShadeAddonFileName,
  );
  if (!pathsEqual(loadedAddon.canonicalPath, expectedLoadedAddonPath)) {
    throw new ExistingReShadeInstallationError(
      'target-module-mismatch',
      'The loaded official ReShade add-on is not the reserved module in the target-effective add-on directory.',
      loadedAddon.canonicalPath,
    );
  }
  const addonDirectoryPath = await requireSafeExistingDirectory(
    effectivePaths.addonDirectoryPath,
    effectivePaths.baseDirectoryPath,
    'loaded ReShade add-on directory',
  );
  const managerResult = await runNativeAddonManager(
    'inspect',
    options.managerExecutablePath,
    addonDirectoryPath,
    addonSource.canonicalPath,
    addonSource.sha256,
    reshadeModule.canonicalPath,
    reshadeModule.sha256,
  );
  if (
    managerResult.status === 'installed' ||
    managerResult.status === 'updated' ||
    managerResult.status === 'removed'
  ) {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      `Read-only manager inspection reported a mutating status (${managerResult.status}).`,
      options.managerExecutablePath,
    );
  }
  if (
    managerResult.status === 'already-current' &&
    (managerResult.addonSha256 !== addonSource.sha256 ||
      loadedAddon.sha256 !== addonSource.sha256 ||
      managerResult.previousAddonSha256 !== null ||
      managerResult.recoveredTransaction ||
      managerResult.restartRequired ||
      !pathsEqual(managerResult.addonPath, loadedAddon.canonicalPath))
  ) {
    throw new ExistingReShadeInstallationError(
      'manager-invalid',
      'The loaded official ReShade add-on could not be proven to be the exact current managed generation.',
      loadedAddon.canonicalPath,
    );
  }
  return {
    status: managerResult.status,
    targetExecutablePath,
    reshadeModulePath: reshadeModule.canonicalPath,
    reshadeModuleSha256: reshadeModule.sha256,
    loadedAddonModulePath: loadedAddon.canonicalPath,
    addonSourcePath: addonSource.canonicalPath,
    addonSourceSha256: addonSource.sha256,
    addonDirectoryPath,
    addonDestinationPath: managerResult.addonPath,
    ownershipMarkerPath: managerResult.markerPath,
    restartRequired: managerResult.status !== 'already-current',
  };
};
