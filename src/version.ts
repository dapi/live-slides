import manifest from '../package.json';

/** package.json is the only source of the application version. */
export const release = {
  version: manifest.version,
  revision: /^[a-f0-9]{40}$/.test(process.env.APP_REVISION ?? '') ? process.env.APP_REVISION : null,
};
