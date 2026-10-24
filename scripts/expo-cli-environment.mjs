/** @file expo cli environment: Make app-local workspace packages visible to the root-hoisted Expo CLI. */

import path from 'node:path';
import process from 'node:process';

/** Make app-local workspace packages visible to the root-hoisted Expo CLI. */
export function createExpoCliEnvironment(root, environment = process.env) {
  const mobileNodeModules = path.join(root, 'mobile', 'node_modules');
  return {
    ...environment,
    NODE_PATH: [mobileNodeModules, environment.NODE_PATH].filter(Boolean).join(path.delimiter)
  };
}
