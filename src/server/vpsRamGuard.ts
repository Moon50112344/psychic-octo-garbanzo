import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const VPS_RAM_REDUCE_THRESHOLD_PERCENT = 95;
export const VPS_RAM_TARGET_PERCENT_AFTER_REDUCE = 80;
export const VPS_RAM_REDUCE_COOLDOWN_MS = 15_000;

export const PROTECTED_HOST_PROCESS_NAMES = new Set([
  'node',
  'tsx',
  'esbuild',
  'vite',
  'npm',
  'npx',
  'bore',
  'qemu-system-x86_64',
  'qemu-system-x86',
  'swtpm',
  'xrdp',
  'xrdp-sesman',
  'xrdp-chansrv',
  'sshd',
  'systemd',
  'init',
  'kthreadd',
  'dbus-daemon',
  'sh',
  'bash',
  'dash',
  'zsh',
  'ps',
  'playwright-cli',
  'chrome-headless-shell',
]);

export interface VpsProcessRssEntry {
  pid: number;
  ppid?: number;
  user: string;
  rssMb: number;
  comm: string;
}

export interface VpsRamReductionInput {
  vmId: string;
  osId: string;
  allocatedMemoryMb: number;
  usedMemoryMb: number;
  lastReducedAtMs?: number;
  nowMs?: number;
  cooldownMs?: number;
  processCandidates?: VpsProcessRssEntry[];
  protectedPids?: number[];
}

export interface VpsRamReductionPlan {
  shouldReduce: boolean;
  skipReason?: 'BELOW_THRESHOLD' | 'COOLDOWN_ACTIVE';
  vmId: string;
  osId: string;
  thresholdPercent: number;
  usedPercent: number;
  usedMemoryMb: number;
  allocatedMemoryMb: number;
  targetMemoryMb: number;
  reclaimNeededMb: number;
  strategy: 'qemu-balloon' | 'vps-process-trim';
  processesToTrim: VpsProcessRssEntry[];
  projectedReclaimMb: number;
}

export interface VpsRamReductionEvent {
  vmId: string;
  osId: string;
  beforeMb: number;
  afterMb: number;
  allocatedMemoryMb: number;
  beforePercent: number;
  afterPercent: number;
  reducedMb: number;
  strategy: 'qemu-balloon' | 'vps-process-trim' | 'cache-and-media-reclaim';
  action: string;
  terminatedProcesses: Array<{ pid: number; comm: string; rssMb: number }>;
  timestamp: string;
}

export function getOsMinRamFloorMb(osId: string): number {
  if (osId === 'windows-10') return 1536;
  if (osId === 'windows-7') return 768;
  return 512;
}

export function isProtectedHostProcess(
  proc: VpsProcessRssEntry,
  extraProtectedPids: number[] = []
): boolean {
  if (!Number.isFinite(proc.pid) || proc.pid <= 1) return true;
  if (proc.pid === process.pid || proc.pid === process.ppid) return true;
  if (extraProtectedPids.includes(proc.pid)) return true;

  const baseName = path.basename((proc.comm || '').trim()).toLowerCase();
  if (!baseName) return true;
  if (PROTECTED_HOST_PROCESS_NAMES.has(baseName)) return true;
  if (baseName.startsWith('qemu') || baseName.startsWith('xrdp')) return true;
  return false;
}

/**
 * Pure decision function for per-VPS automatic RAM reduction.
 * Triggers when VPS RAM usage reaches >= 95% (95%, 96%, ...), never targeting the host server quota.
 */
export function evaluateVpsRamReduction(input: VpsRamReductionInput): VpsRamReductionPlan {
  const allocatedMemoryMb = Math.max(256, Math.round(input.allocatedMemoryMb));
  const usedMemoryMb = Math.max(0, Math.round(input.usedMemoryMb));
  const rawPercent = (usedMemoryMb / allocatedMemoryMb) * 100;
  const usedPercent = Math.min(100, Math.round(rawPercent * 10) / 10);
  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
  const cooldownMs = typeof input.cooldownMs === 'number' ? input.cooldownMs : VPS_RAM_REDUCE_COOLDOWN_MS;
  const strategy: 'qemu-balloon' | 'vps-process-trim' =
    input.osId === 'windows-10' || input.osId === 'windows-7' ? 'qemu-balloon' : 'vps-process-trim';

  const minFloorMb = Math.min(allocatedMemoryMb - 64, getOsMinRamFloorMb(input.osId));
  const rawTargetMb = Math.floor(allocatedMemoryMb * (VPS_RAM_TARGET_PERCENT_AFTER_REDUCE / 100));
  const targetMemoryMb = Math.max(Math.max(128, minFloorMb), Math.min(allocatedMemoryMb - 64, rawTargetMb));
  const reclaimNeededMb = Math.max(0, usedMemoryMb - targetMemoryMb);

  if (usedPercent < VPS_RAM_REDUCE_THRESHOLD_PERCENT) {
    return {
      shouldReduce: false,
      skipReason: 'BELOW_THRESHOLD',
      vmId: input.vmId,
      osId: input.osId,
      thresholdPercent: VPS_RAM_REDUCE_THRESHOLD_PERCENT,
      usedPercent,
      usedMemoryMb,
      allocatedMemoryMb,
      targetMemoryMb,
      reclaimNeededMb: 0,
      strategy,
      processesToTrim: [],
      projectedReclaimMb: 0,
    };
  }

  if (typeof input.lastReducedAtMs === 'number' && nowMs - input.lastReducedAtMs < cooldownMs) {
    return {
      shouldReduce: false,
      skipReason: 'COOLDOWN_ACTIVE',
      vmId: input.vmId,
      osId: input.osId,
      thresholdPercent: VPS_RAM_REDUCE_THRESHOLD_PERCENT,
      usedPercent,
      usedMemoryMb,
      allocatedMemoryMb,
      targetMemoryMb,
      reclaimNeededMb,
      strategy,
      processesToTrim: [],
      projectedReclaimMb: 0,
    };
  }

  const protectedPids = input.protectedPids || [];
  const processesToTrim: VpsProcessRssEntry[] = [];
  let projectedReclaimMb = 0;

  if (strategy === 'vps-process-trim' && Array.isArray(input.processCandidates)) {
    const eligible = input.processCandidates
      .filter((p) => p.rssMb > 0 && !isProtectedHostProcess(p, protectedPids))
      .sort((a, b) => b.rssMb - a.rssMb);

    for (const proc of eligible) {
      if (projectedReclaimMb >= reclaimNeededMb && processesToTrim.length > 0) {
        break;
      }
      processesToTrim.push(proc);
      projectedReclaimMb += proc.rssMb;
    }
  } else if (strategy === 'qemu-balloon') {
    projectedReclaimMb = reclaimNeededMb;
  }

  return {
    shouldReduce: true,
    vmId: input.vmId,
    osId: input.osId,
    thresholdPercent: VPS_RAM_REDUCE_THRESHOLD_PERCENT,
    usedPercent,
    usedMemoryMb,
    allocatedMemoryMb,
    targetMemoryMb,
    reclaimNeededMb,
    strategy,
    processesToTrim,
    projectedReclaimMb: Math.round(projectedReclaimMb),
  };
}

/**
 * Reads real VmRSS (resident set size in MB) for a single PID from /proc/<pid>/status.
 */
export function readPidRssMb(pid: number): number {
  if (!Number.isFinite(pid) || pid <= 0) return 0;
  try {
    const statusPath = `/proc/${pid}/status`;
    if (!fs.existsSync(statusPath)) return 0;
    const content = fs.readFileSync(statusPath, 'utf8');
    const match = content.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (!match) return 0;
    const kb = Number(match[1]);
    if (!Number.isFinite(kb) || kb <= 0) return 0;
    return Math.round((kb / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * Reads running OS processes owned by the Debian VPS user/session, strictly excluding host daemons.
 */
export function inspectDebianVpsProcesses(vpsUsername: string): VpsProcessRssEntry[] {
  const normalizedTargetUser = (vpsUsername || '').trim().toLowerCase();
  try {
    const stdout = execFileSync('ps', ['-eo', 'pid=,ppid=,user=,rss=,comm='], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entries: VpsProcessRssEntry[] = [];
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const user = match[3];
      const rssKb = Number(match[4]);
      const comm = match[5].trim();
      if (!Number.isFinite(pid) || !Number.isFinite(rssKb)) continue;

      const userLower = user.toLowerCase();
      const belongsToVpsUser =
        (normalizedTargetUser && userLower === normalizedTargetUser) ||
        userLower.startsWith('moon_') ||
        userLower === 'administrator';

      const entry: VpsProcessRssEntry = {
        pid,
        ppid,
        user,
        rssMb: Math.round((rssKb / 1024) * 10) / 10,
        comm,
      };

      if (belongsToVpsUser && !isProtectedHostProcess(entry)) {
        entries.push(entry);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Measures real Debian 12 VPS resident RAM usage (VPS user session processes + lightweight XRDP session baseline),
 * strictly reflecting the VPS rather than global host free memory.
 */
export function measureDebianVpsUsedRamMb(vpsUsername: string, allocatedMemoryMb: number): number {
  const procs = inspectDebianVpsProcesses(vpsUsername);
  const userProcRssMb = procs.reduce((sum, p) => sum + p.rssMb, 0);
  // Base XRDP + XFCE session overhead for the container desktop session
  const sessionBaselineMb = 140;
  const totalUsed = Math.round(sessionBaselineMb + userProcRssMb);
  return Math.min(Math.max(120, allocatedMemoryMb), Math.max(120, totalUsed));
}

export function cleanVpsUserTempCaches(vpsUsername: string): number {
  let reclaimedMb = 0;
  const cacheDirs = [
    path.join(os.homedir(), '.cache', 'thumbnails'),
    `/home/${vpsUsername}/.cache/thumbnails`,
  ];

  for (const dir of cacheDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isFile()) {
            const size = fs.statSync(fullPath).size;
            fs.unlinkSync(fullPath);
            reclaimedMb += size / (1024 * 1024);
          }
        } catch {
          // ignore locked cache file
        }
      }
    } catch {
      // ignore missing home dir
    }
  }

  // Safe optional kernel pagecache drop only when container/host exposes writable drop_caches
  try {
    if (fs.existsSync('/proc/sys/vm/drop_caches')) {
      fs.writeFileSync('/proc/sys/vm/drop_caches', '1', 'utf8');
    }
  } catch {
    // gVisor or non-privileged container does not expose /proc/sys/vm/drop_caches
  }

  return Math.round(reclaimedMb * 10) / 10;
}

export function executeDebianVpsProcessTrim(
  processesToTrim: VpsProcessRssEntry[]
): Array<{ pid: number; comm: string; rssMb: number }> {
  const terminated: Array<{ pid: number; comm: string; rssMb: number }> = [];
  for (const proc of processesToTrim) {
    if (isProtectedHostProcess(proc)) continue;
    try {
      process.kill(proc.pid, 'SIGTERM');
      terminated.push({ pid: proc.pid, comm: proc.comm, rssMb: proc.rssMb });
    } catch {
      // process already exited or permission denied
    }
  }
  return terminated;
}
