/** @file Application entrypoint that initializes Expo Router. */

// Keep the native release entry inside the mobile project so Metro preserves the
// correct monorepo root when expo-router is hoisted to the workspace node_modules.
import 'expo-router/entry';
