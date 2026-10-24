/** @file Host-safe launcher for Detekt's existing Kotlin documentation rules. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const wrapper = path.join(root, 'wear', windows ? 'gradlew.bat' : 'gradlew');
const args = [
  '--project-dir', path.join(root, 'tools', 'kotlin-lint'),
  'lint', '--dependency-verification=strict', '--no-daemon', '--console=plain',
];
// Invoke the wrapper's Java entrypoint directly on Windows to avoid cmd quoting of workspace paths.
let command = wrapper;
if (windows) {
  command = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java.exe';
}
const commandArgs = windows ? [
  '-classpath', path.join(root, 'wear', 'gradle', 'wrapper', 'gradle-wrapper.jar'),
  'org.gradle.wrapper.GradleWrapperMain', ...args,
] : args;
const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
