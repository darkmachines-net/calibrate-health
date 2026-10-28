/** @file Validates the Calibrate plugin and emits an immutable DarkMachines catalog entry without publishing or changing files. */

import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_PATH = 'plugins/calibrate-health';
const PLUGIN_NAME = 'calibrate-health';
const MCP_URL = 'https://calibratehealth.darkmachines.net/mcp';
const SOURCE_URL = 'ssh://git@github.com/MChartier/calibrate-health.git';
const LICENSE = 'PolyForm-Shield-1.0.0';
const TOOL_NAMES = [
  'open_progress_explorer', 'get_progress_summary', 'compare_progress_periods',
  'get_recent_food_logs', 'get_weight_trend',
];

/** Fail closed with an actionable diagnostic for invalid authoring or publication inputs. */
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Reject package paths escaping the installed subdirectory, including symlinks. */
async function packagePath(root, relativePath, expectedType) {
  requireValue(typeof relativePath === 'string' && relativePath.startsWith('./'), 'Plugin paths must begin with ./ and remain inside the package.');
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Invalid plugin path: ${relativePath}`);
  const info = await lstat(absolute);
  requireValue(!info.isSymbolicLink() && (expectedType === 'directory' ? info.isDirectory() : info.isFile()), `Plugin ${relativePath} must be a regular ${expectedType}.`);
  const resolved = path.relative(await realpath(root), await realpath(absolute));
  requireValue(resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved), `Plugin path escapes package: ${relativePath}`);
  return absolute;
}

/** Parse owned JSON and keep path-specific errors useful when authoring metadata. */
async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read plugin JSON ${filename}: ${error.message}`, { cause: error });
  }
}

/** Require public HTTPS metadata without embedded credentials or URL fragments. */
function validatePublicUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL.`);
  }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash, `${field} must be an HTTPS URL without credentials or fragments.`);
}

/**
 * Validate the current plugin, its packaged license/notices, OAuth wiring, and skill dependencies.
 * Reads only local files and does not require Git history, network access, or a release commit.
 * Returns the validated manifest; invalid or missing files reject with an actionable error.
 */
export async function validatePlugin(root = REPOSITORY_ROOT) {
  const pluginRoot = path.resolve(root, PLUGIN_PATH);
  const manifest = await readJson(await packagePath(pluginRoot, './.codex-plugin/plugin.json', 'file'));
  requireValue(manifest.name === PLUGIN_NAME, `Plugin name must be ${PLUGIN_NAME}.`);
  requireValue(typeof manifest.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version), 'Plugin version must be a stable semantic version.');
  requireValue(manifest.license === LICENSE, `Plugin license must be ${LICENSE}.`);
  requireValue(typeof manifest.description === 'string' && manifest.description.trim(), 'Plugin description is required.');
  requireValue(typeof manifest.author?.name === 'string' && manifest.author.name.trim(), 'Plugin author.name is required.');
  validatePublicUrl(manifest.author?.url, 'author.url');
  validatePublicUrl(manifest.homepage, 'homepage');
  requireValue(manifest.repository === 'https://github.com/MChartier/calibrate-health', 'Plugin repository must identify the Calibrate source.');
  requireValue(Array.isArray(manifest.keywords) && manifest.keywords.length > 0 && manifest.keywords.every((value) => typeof value === 'string' && value.trim()), 'Plugin keywords must be nonempty strings.');
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName']) {
    requireValue(typeof manifest.interface?.[field] === 'string' && manifest.interface[field].trim(), `interface.${field} is required.`);
  }
  requireValue(manifest.interface.category === 'Productivity', 'Plugin category must be Productivity.');
  requireValue(Array.isArray(manifest.interface.capabilities) && [...manifest.interface.capabilities].sort().join(',') === 'Interactive,Read', 'Plugin capabilities must be Interactive and Read.');
  requireValue(Array.isArray(manifest.interface.defaultPrompt) && manifest.interface.defaultPrompt.length > 0 && manifest.interface.defaultPrompt.every((value) => typeof value === 'string' && value.trim()), 'Plugin discovery prompts must be nonempty strings.');
  for (const field of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) validatePublicUrl(manifest.interface[field], `interface.${field}`);

  const mcp = await readJson(await packagePath(pluginRoot, manifest.mcpServers, 'file'));
  requireValue(Object.keys(mcp.mcpServers ?? {}).join(',') === 'calibrate', 'Package exactly the calibrate MCP server.');
  const server = mcp.mcpServers.calibrate;
  requireValue(server.type === 'http' && server.url === MCP_URL && server.auth === 'oauth', `Calibrate must use HTTP OAuth at ${MCP_URL}.`);
  requireValue(Object.keys(server).sort().join(',') === 'auth,type,url', 'MCP configuration must contain only type, url, and auth; credentials belong in the host OAuth flow.');

  const skillsRoot = await packagePath(pluginRoot, manifest.skills, 'directory');
  requireValue(path.relative(pluginRoot, skillsRoot).split(path.sep).join('/') === 'skills', 'Bundle skills under ./skills/.');
  const skillPath = await packagePath(pluginRoot, './skills/calibrate-progress/SKILL.md', 'file');
  const skill = await readFile(skillPath, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/.exec(skill);
  requireValue(frontmatter, 'The progress skill requires YAML frontmatter.');
  const skillMetadata = parseYaml(frontmatter[1]);
  requireValue(skillMetadata?.name === 'calibrate-progress' && typeof skillMetadata.description === 'string' && skillMetadata.description.trim(), 'The progress skill requires its canonical name and a description.');
  for (const tool of TOOL_NAMES) requireValue(skill.includes(`\`${tool}\``), `The progress skill must describe ${tool}.`);
  const agent = parseYaml(await readFile(await packagePath(pluginRoot, './skills/calibrate-progress/agents/openai.yaml', 'file'), 'utf8'));
  requireValue(typeof agent.interface?.default_prompt === 'string' && agent.interface.default_prompt.includes('$calibrate-progress'), 'The skill prompt must invoke $calibrate-progress.');
  const dependencies = agent.dependencies?.tools;
  requireValue(Array.isArray(dependencies) && dependencies.length === 1, 'The progress skill must depend only on the calibrate MCP server.');
  const dependency = dependencies[0];
  requireValue(dependency.type === 'mcp' && dependency.value === 'calibrate' && dependency.transport === 'streamable_http' && dependency.url === server.url, 'Skill MCP dependency must match the OAuth server name, transport, and endpoint.');
  for (const filename of ['LICENSE', 'NOTICE']) {
    const packaged = await readFile(await packagePath(pluginRoot, `./${filename}`, 'file'), 'utf8');
    const repository = await readFile(path.join(root, filename), 'utf8');
    requireValue(packaged.replaceAll('\r\n', '\n') === repository.replaceAll('\r\n', '\n'), `Plugin ${filename} must match the root ${filename} for subdirectory distribution.`);
  }
  return manifest;
}

/** Enumerate package bytes deterministically and reject symlinks or special files. */
async function listPackageFiles(root, relative = PLUGIN_PATH) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = `${relative}/${entry.name}`;
    requireValue(!entry.isSymbolicLink(), `Plugin package cannot contain symlinks: ${filename}`);
    if (entry.isDirectory()) files.push(...await listPackageFiles(root, filename));
    else {
      requireValue(entry.isFile(), `Plugin package cannot contain special files: ${filename}`);
      files.push(filename);
    }
  }
  return files.sort();
}

/** Run bounded, read-only Git commands without shell interpolation or interactive credential prompts. */
function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Create a catalog entry only for an immutable, published revision matching every current package file
 * after Git's configured normalization, including Windows text line endings.
 * Git reads verify local commit contents and reachability from advertised origin refs; no fetch, push,
 * commit, or marketplace mutation occurs. The optional read-only runner supports isolated Git fixtures.
 */
export async function createMarketplaceEntry({ root = REPOSITORY_ROOT, ref, gitRunner = runGit }) {
  requireValue(typeof ref === 'string' && /^[a-f0-9]{40}$/.test(ref), 'marketplace-entry requires --ref with a full lowercase 40-character commit SHA.');
  const manifest = await validatePlugin(root);
  requireValue(gitRunner(root, ['cat-file', '-t', ref]).trim() === 'commit', '--ref must identify a commit, not a tag or tree.');
  const records = gitRunner(root, ['ls-tree', '-r', '-z', ref, '--', PLUGIN_PATH]).split('\0').filter(Boolean);
  const committedFiles = new Map();
  for (const record of records) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    requireValue(match, `Source revision contains a non-file plugin entry: ${record}`);
    committedFiles.set(match[3], match[2]);
  }
  const currentFiles = await listPackageFiles(root);
  requireValue(JSON.stringify([...committedFiles.keys()].sort()) === JSON.stringify(currentFiles), 'Source revision must include exactly the current plugin package files; commit all package changes first.');
  for (const filename of currentFiles) {
    const currentHash = gitRunner(root, ['hash-object', '--path', filename, '--', path.resolve(root, filename)]).trim();
    requireValue(currentHash === committedFiles.get(filename), `Source revision differs from ${filename}; commit the reviewed package and use that SHA.`);
  }
  let advertised;
  try {
    advertised = gitRunner(root, ['ls-remote', SOURCE_URL]);
  } catch {
    throw new Error(`Cannot verify published source at ${SOURCE_URL}; check Git/SSH access and retry after publishing the source commit.`);
  }
  const remoteCommits = new Set(advertised.split(/\r?\n/).map((line) => /^([a-f0-9]{40})\s+/.exec(line)?.[1]).filter(Boolean));
  const published = remoteCommits.has(ref) || [...remoteCommits].some((tip) => {
    try {
      gitRunner(root, ['merge-base', '--is-ancestor', ref, tip]);
      return true;
    } catch {
      return false;
    }
  });
  requireValue(published, 'Source SHA is not verifiably reachable from published refs; publish it and ensure the advertised branch history is available locally.');
  return {
    name: manifest.name,
    source: { source: 'git-subdir', url: SOURCE_URL, path: `./${PLUGIN_PATH}`, ref },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: manifest.interface.category,
  };
}

/** Parse the deliberately small CLI and print validation or JSON without editing another repository. */
async function main(args = process.argv.slice(2)) {
  const [command = 'check', ...rest] = args;
  if (command === 'check') {
    requireValue(rest.length === 0, 'Usage: node scripts/calibrate-plugin.mjs check');
    const manifest = await validatePlugin();
    console.log(`Calibrate plugin ${manifest.version}: metadata, OAuth wiring, skill, license, and notices are valid.`);
    return;
  }
  requireValue(command === 'marketplace-entry' && rest.length === 2 && rest[0] === '--ref', 'Usage: node scripts/calibrate-plugin.mjs marketplace-entry --ref <40-character-commit-sha>');
  console.log(JSON.stringify(await createMarketplaceEntry({ ref: rest[1] }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
