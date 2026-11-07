/** @file Credential-free Terraform formatting/schema/mock checks in disposable directories, never an operator's real backend or tfvars. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const executable = process.env.TERRAFORM_BIN || 'terraform';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-gcp-check-'));
// Strip operator Terraform variables/config/credentials. Tests exclusively use mocked providers.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TF_|GOOGLE_|GCLOUD_|CLOUDSDK_)/i.test(key)));
environment.TF_IN_AUTOMATION = '1';

/** Run a bounded Terraform check; preserve diagnostics and propagate every failure. */
function run(args, cwd) {
  const result = spawnSync(executable, args, { cwd, env: environment, stdio: 'inherit', windowsHide: true, timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `Terraform ${args[0]} failed (${result.status}).`);
}

/** Copy only reviewed configuration, tests and provider locks, excluding state and all operator values. */
function copyConfiguration(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'tests') copyConfiguration(path.join(source, entry.name), path.join(target, entry.name));
    if (entry.isFile() && /(?:\.tf|\.tftest\.hcl|^\.terraform\.lock\.hcl)$/.test(entry.name)) {
      fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
    }
  }
}

try {
  run(['fmt', '-check', '-recursive', directory], directory);
  for (const module of ['bootstrap', '.']) {
    const target = path.join(temporary, module === '.' ? 'application' : module);
    copyConfiguration(path.join(directory, module), target);
    run(['init', '-backend=false', '-input=false', '-lockfile=readonly'], target);
    run(['validate'], target);
    run(['test'], target);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // mkdtemp supplies an absolute, task-owned directory; never remove the operator checkout or state.
  fs.rmSync(temporary, { recursive: true, force: true });
}
