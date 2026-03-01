import fs from 'fs/promises';
import path from 'path';

export interface AssertPathAllowedOptions {
  allowMissing?: boolean;
  allowAgentPrivate?: boolean;
}

export function isInsideDir(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveInsideRoot(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, relativePath || '.');

  if (!isInsideDir(normalizedRoot, candidate)) {
    throw new Error(`Path traversal denied: "${relativePath}" resolves outside allowed root`);
  }

  return candidate;
}

export function isAgentPrivatePath(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const agentDir = path.resolve(normalizedRoot, '.agentwfy');
  const normalizedCandidate = path.resolve(candidate);
  return isInsideDir(agentDir, normalizedCandidate);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function findNearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;

  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return current;
}

async function resolveRootRealPath(root: string): Promise<string> {
  const normalizedRoot = path.resolve(root);
  try {
    return await fs.realpath(normalizedRoot);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return normalizedRoot;
    }
    throw error;
  }
}

export async function assertPathAllowed(
  root: string,
  relativePath: string,
  options: AssertPathAllowedOptions = {}
): Promise<string> {
  const allowMissing = options.allowMissing ?? false;
  const allowAgentPrivate = options.allowAgentPrivate ?? false;

  const normalizedRoot = path.resolve(root);
  const candidate = resolveInsideRoot(normalizedRoot, relativePath);
  const rootRealPath = await resolveRootRealPath(normalizedRoot);

  if (!allowAgentPrivate && isAgentPrivatePath(rootRealPath, candidate)) {
    throw new Error(`Access denied for private path: "${relativePath}"`);
  }

  const candidateExists = await pathExists(candidate);

  if (candidateExists) {
    const candidateRealPath = await fs.realpath(candidate);
    if (!isInsideDir(rootRealPath, candidateRealPath)) {
      throw new Error(`Path escape denied: "${relativePath}" resolves outside allowed root`);
    }

    if (!allowAgentPrivate && isAgentPrivatePath(rootRealPath, candidateRealPath)) {
      throw new Error(`Access denied for private path: "${relativePath}"`);
    }

    return candidateRealPath;
  }

  if (!allowMissing) {
    throw new Error(`Path does not exist: "${relativePath}"`);
  }

  const existingAncestor = await findNearestExistingAncestor(candidate);
  const ancestorRealPath = await fs.realpath(existingAncestor);
  if (!isInsideDir(rootRealPath, ancestorRealPath)) {
    throw new Error(`Path escape denied: "${relativePath}" resolves through symlink outside allowed root`);
  }

  if (!allowAgentPrivate && isAgentPrivatePath(rootRealPath, ancestorRealPath)) {
    throw new Error(`Access denied for private path: "${relativePath}"`);
  }

  return candidate;
}
