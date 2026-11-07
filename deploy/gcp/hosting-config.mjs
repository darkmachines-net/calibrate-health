/** @file Write the Terraform-owned, non-secret Firebase Hosting configuration without publishing a release or changing DNS. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const output = execFileSync(process.env.TERRAFORM_BIN || 'terraform', ['output', '-json', 'firebase_config'], {
  cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe']
});
const config = JSON.parse(output);
if (!config.hosting?.site || config.hosting.rewrites?.[0]?.run?.pinTag !== true) {
  throw new Error('Apply the GCP foundation configuration before generating the Hosting configuration.');
}
fs.writeFileSync(path.join(directory, 'firebase.generated.json'), JSON.stringify(config, null, 2) + '\n');
console.log('Wrote deploy/gcp/firebase.generated.json. Verify API readiness before publishing Hosting.');
