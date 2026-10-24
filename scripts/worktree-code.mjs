#!/usr/bin/env node
/** @file Open a selected repository worktree in the local editor after resolving its Git identity. */

import { execFileSync } from "node:child_process";

/**
 * Run a git command and return trimmed stdout.
 * @param {string[]} args - Arguments to pass to git.
 * @returns {string} Trimmed stdout content.
 */
function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Parse `git worktree list --porcelain` into entries with path and branch.
 * @param {string} output - Raw porcelain output.
 * @returns {{ path: string, branch: string | null }[]} Parsed entries.
 */
function parseWorktreeEntries(output) {
  const entries = [];
  let current = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim(), branch: null };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

/**
 * Resolve the worktree path for a branch name.
 * @param {{ path: string, branch: string | null }[]} entries - Worktree entries.
 * @param {string} branchName - Branch name to match.
 * @returns {string} Matching worktree path.
 */
function resolveWorktreePath(entries, branchName) {
  const match = entries.find((entry) => entry.branch === branchName);
  if (!match) {
    throw new Error(`No worktree found for branch "${branchName}".`);
  }
  return match.path;
}

const branchName = process.argv[2];
if (!branchName) {
  console.error("Usage: npm run worktree:code -- <branch>");
  process.exit(1);
}

const worktreeList = runGit(["worktree", "list", "--porcelain"]);
const entries = parseWorktreeEntries(worktreeList);
const worktreePath = resolveWorktreePath(entries, branchName);

execFileSync("code", [worktreePath], { stdio: "inherit" });
