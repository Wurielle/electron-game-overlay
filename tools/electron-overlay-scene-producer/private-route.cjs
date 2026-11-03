const path = require('node:path');

const RUN_DIRECTORY_ARGUMENT = '--overlay-run-directory=';
const DISCOVERY_FILE_NAME = 'electron-overlay-transport-v1.json';

function parseSceneRunDirectory(arguments_) {
  const matches = arguments_.filter((argument) =>
    argument.startsWith(RUN_DIRECTORY_ARGUMENT),
  );
  if (matches.length > 1) {
    throw new TypeError(`${RUN_DIRECTORY_ARGUMENT}<path> may only be supplied once`);
  }
  if (matches.length === 0) return undefined;
  const directory = matches[0].slice(RUN_DIRECTORY_ARGUMENT.length);
  if (!path.isAbsolute(directory) || directory.includes('\0')) {
    throw new TypeError(
      `${RUN_DIRECTORY_ARGUMENT}<path> must be an absolute directory without NUL characters`,
    );
  }
  return path.resolve(directory);
}

async function publishSceneRunRoute(session, runDirectory, authorizeGlobalTarget) {
  if (runDirectory === undefined) return undefined;
  return authorizeGlobalTarget(
    session,
    path.join(runDirectory, DISCOVERY_FILE_NAME),
  );
}

module.exports = { parseSceneRunDirectory, publishSceneRunRoute };
