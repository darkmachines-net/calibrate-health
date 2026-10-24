#!/usr/bin/env node
/** @file Creates an unused Greek-named Git worktree with relative Git metadata paths. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
 * Run a git command and return stdout.
 * @param {string[]} args - Arguments to pass to git.
 * @returns {string} Trimmed stdout content.
 */
function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Parse `git worktree list --porcelain` into a list of worktree paths.
 * @param {string} output - Raw porcelain output.
 * @returns {string[]} Worktree paths.
 */
function parseWorktreePaths(output) {
  const paths = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

/**
 * Resolve the base repo name from the current worktree path.
 * @param {string} worktreeRoot - Current worktree path.
 * @returns {string} Base repo name used to prefix worktree folders.
 */
function resolveBaseName(worktreeRoot) {
  const base = path.basename(worktreeRoot);
  for (const letter of GREEK_LETTERS) {
    const suffix = `-${letter}`;
    if (base.endsWith(suffix)) {
      return base.slice(0, -suffix.length);
    }
  }
  return base;
}

/**
 * Extract a Greek letter suffix from a worktree folder name.
 * @param {string} worktreeName - Worktree folder name.
 * @param {string} baseName - Base repo name prefix.
 * @returns {string|null} Letter if present.
 */
function extractLetterFromWorktreeName(worktreeName, baseName) {
  for (const letter of GREEK_LETTERS) {
    const expected = `${baseName}-${letter}`;
    if (worktreeName === expected) {
      return letter;
    }
  }
  return null;
}

/**
 * Find the first available Greek letter not used by a branch or worktree.
 * @param {Set<string>} branches - Existing branch names.
 * @param {Set<string>} usedLetters - Letters already used by worktrees.
 * @returns {string} Available letter.
 */
function findAvailableLetter(branches, usedLetters) {
  for (const letter of GREEK_LETTERS) {
    if (!branches.has(letter) && !usedLetters.has(letter)) {
      return letter;
    }
  }
  throw new Error("No available Greek letters for new worktree.");
}

/**
 * Rewrite the worktree .git file to use a relative gitdir.
 * @param {string} worktreePath - Path to the new worktree.
 * @param {string} gitCommonDir - Path to the main .git directory.
 */
function rewriteWorktreeGitFile(worktreePath, gitCommonDir) {
  const mainRepoRoot = path.dirname(gitCommonDir);
  const relativeToMain = path.relative(worktreePath, mainRepoRoot) || ".";
  const worktreeName = path.basename(worktreePath);
  const relativeGitDir = path.join(
    relativeToMain,
    ".git",
    "worktrees",
    worktreeName
  );

  fs.writeFileSync(
    path.join(worktreePath, ".git"),
    `gitdir: ${relativeGitDir}\n`,
    "utf8"
  );
}

const worktreeRoot = runGit(["rev-parse", "--show-toplevel"]);
const gitCommonDir = runGit(["rev-parse", "--git-common-dir"]);
const parentDir = path.dirname(worktreeRoot);
const baseName = resolveBaseName(worktreeRoot);

const branchList = runGit([
  "for-each-ref",
  "--format=%(refname:short)",
  "refs/heads",
]);
const branchSet = new Set(branchList.split("\n").filter(Boolean));

const worktreeList = runGit(["worktree", "list", "--porcelain"]);
const worktreePaths = parseWorktreePaths(worktreeList);
const worktreeNames = worktreePaths.map((worktreePath) =>
  path.basename(worktreePath)
);
const usedLetters = new Set(
  worktreeNames
    .map((worktreeName) => extractLetterFromWorktreeName(worktreeName, baseName))
    .filter(Boolean)
);

const letter = findAvailableLetter(branchSet, usedLetters);
const branchName = letter;
const worktreePath = path.join(parentDir, `${baseName}-${branchName}`);

runGit(["worktree", "add", "--relative-paths", "-b", branchName, worktreePath]);
rewriteWorktreeGitFile(worktreePath, gitCommonDir);

console.log(`Created worktree: ${worktreePath} (branch: ${branchName})`);
