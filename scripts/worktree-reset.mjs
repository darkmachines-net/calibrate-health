#!/usr/bin/env node
/** @file Explicitly resets a named disposable worktree branch to local master, with optional dry-run output. */

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const GREEK_LETTERS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "omicron",
  "pi",
  "rho",
  "sigma",
  "tau",
  "upsilon",
  "phi",
  "chi",
  "psi",
  "omega",
];

/**
 * Run a git command and return trimmed stdout.
 * @param {string[]} args - Arguments to pass to git.
 * @returns {string} Trimmed stdout content.
 */
function runGitCapture(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Run a git command and inherit stdio (for user-visible progress/errors).
 * @param {string[]} args - Arguments to pass to git.
 */
function runGitInherit(args) {
  execFileSync("git", args, { stdio: "inherit" });
}

/**
 * Check whether a local branch exists.
 * @param {string} branchName - Local branch name (e.g. "alpha", "master").
 * @returns {boolean} True if the branch exists locally.
 */
function hasLocalBranch(branchName) {
  const result = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { stdio: "ignore" }
  );
  return result.status === 0;
}

/**
 * Resolve the Greek letter "slot" from a worktree folder name.
 * @param {string} worktreeRoot - Absolute path to the worktree root.
 * @returns {string|null} Greek letter (e.g. "alpha") or null if not detected.
 */
function resolveLetterFromWorktreeRoot(worktreeRoot) {
  const base = path.basename(worktreeRoot);
  for (const letter of GREEK_LETTERS) {
    if (base === letter || base.endsWith(`-${letter}`)) {
      return letter;
    }
  }
  return null;
}

/**
 * Print CLI usage information.
 */
function printHelp() {
  console.log(
    [
      "Reset the current Greek-letter worktree branch to local master.",
      "",
      "Usage:",
      "  npm run worktree:reset",
      "  npm run worktree:reset -- --dry-run",
      "",
      "Notes:",
      "  - Must be run from a worktree whose folder name ends with a Greek letter",
      "    (e.g. cal-io-alpha).",
      "  - Performs: git switch -f <letter> && git reset --hard master",
    ].join("\n")
  );
}

const argv = new Set(process.argv.slice(2));
if (argv.has("--help") || argv.has("-h")) {
  printHelp();
  process.exit(0);
}

const dryRun = argv.has("--dry-run") || argv.has("-n");

const worktreeRoot = runGitCapture(["rev-parse", "--show-toplevel"]);
const letter = resolveLetterFromWorktreeRoot(worktreeRoot);
if (!letter) {
  console.error(
    [
      "worktree:reset must be run from a Greek-letter worktree folder.",
      `Detected worktree root: ${worktreeRoot}`,
      "Expected folder name to be <repo>-alpha, <repo>-beta, etc.",
    ].join("\n")
  );
  process.exit(1);
}

if (!hasLocalBranch(letter)) {
  console.error(
    [
      `Local branch "${letter}" does not exist.`,
      "This script assumes your worktree's canonical branch name is the Greek letter.",
      'If needed, create one via "npm run worktree:new".',
    ].join("\n")
  );
  process.exit(1);
}

if (!hasLocalBranch("master")) {
  console.error(
    [
      'Local branch "master" does not exist.',
      'If your default branch is named differently (e.g. "main"), update scripts/worktree-reset.mjs.',
    ].join("\n")
  );
  process.exit(1);
}

const commands = [
  ["git", ["switch", "-f", letter]],
  ["git", ["reset", "--hard", "master"]],
];

if (dryRun) {
  for (const [cmd, args] of commands) {
    console.log([cmd, ...args].join(" "));
  }
  process.exit(0);
}

runGitInherit(["switch", "-f", letter]);
runGitInherit(["reset", "--hard", "master"]);

console.log(`Reset "${letter}" to "master" (${worktreeRoot})`);

