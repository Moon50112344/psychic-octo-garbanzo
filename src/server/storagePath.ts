import fs from 'node:fs';
import path from 'node:path';

export interface ResolvedStorageLocation {
  dataDir: string;
  storageType: 'persistent-volume' | 'workspace-data';
  mountPoint?: string;
  fsType?: string;
}

const PERSISTENT_CANDIDATE_ROOTS = ['/data', '/mnt/data', '/persistent', '/storage'] as const;
const EPHEMERAL_FS_TYPES = new Set([
  'tmpfs',
  'ramfs',
  'overlay',
  'proc',
  'sysfs',
  'devtmpfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'squashfs',
]);

export function parseMountedPersistentPaths(
  procMountsContent: string
): Array<{ mountPoint: string; fsType: string }> {
  const results: Array<{ mountPoint: string; fsType: string }> = [];
  for (const rawLine of procMountsContent.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const mountPoint = parts[1];
    const fsType = parts[2].toLowerCase();
    if (EPHEMERAL_FS_TYPES.has(fsType)) continue;
    if (
      PERSISTENT_CANDIDATE_ROOTS.some(
        (cand) => mountPoint === cand || mountPoint.startsWith(`${cand}/`)
      )
    ) {
      results.push({ mountPoint, fsType });
    }
  }
  return results;
}

export function resolvePersistentStorageRoot(options?: {
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  procMountsContent?: string;
  isWritableDir?: (dir: string) => boolean;
}): ResolvedStorageLocation {
  const workspaceRoot = options?.workspaceRoot || process.cwd();
  const env = options?.env || process.env;
  const checkWritable =
    options?.isWritableDir ||
    ((dir: string) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });

  // 1. Explicit environment override when hosting supplies a persistent mount path
  const envOverride = (env.MOON_STORAGE_DIR || env.PERSISTENT_STORAGE_DIR || '').trim();
  if (envOverride) {
    const resolved = path.resolve(envOverride);
    if (checkWritable(resolved)) {
      return {
        dataDir: resolved,
        storageType: 'persistent-volume',
        mountPoint: resolved,
        fsType: 'env-configured',
      };
    }
  }

  // 2. Auto-detect mounted persistent volumes (excluding ephemeral tmpfs/overlay)
  // Only check when using the real workspace root (never hijack unit-test tmpDirs)
  if (!options?.workspaceRoot || options.procMountsContent !== undefined) {
    let mountsContent = options?.procMountsContent || '';
    if (!mountsContent && fs.existsSync('/proc/mounts')) {
      try {
        mountsContent = fs.readFileSync('/proc/mounts', 'utf8');
      } catch {
        mountsContent = '';
      }
    }
    if (mountsContent) {
      const candidates = parseMountedPersistentPaths(mountsContent);
      for (const cand of candidates) {
        const subDir = path.join(cand.mountPoint, 'moon-cloud');
        if (checkWritable(subDir)) {
          return {
            dataDir: subDir,
            storageType: 'persistent-volume',
            mountPoint: cand.mountPoint,
            fsType: cand.fsType,
          };
        }
      }
    }
  }

  // 3. Fallback to workspace data/ directory
  const workspaceData = path.join(workspaceRoot, 'data');
  try {
    fs.mkdirSync(workspaceData, { recursive: true });
  } catch {
    // ignore
  }
  return {
    dataDir: workspaceData,
    storageType: 'workspace-data',
  };
}
