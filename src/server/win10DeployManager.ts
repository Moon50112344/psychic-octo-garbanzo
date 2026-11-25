import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { serverLogger } from './logger';
import {
  DOCKUR_MIRROR_CATALOG,
  computeFileSha256,
  dockurEngine,
  getAvailableDiskBytes,
  isMemoryBackedOverlayfs,
} from './dockurEngine';
import { evaluateIsoChecksum } from './win7Lifecycle';
import {
  probeHostInfrastructure,
  resolveOvmfPaths,
  type HostInfrastructureReport,
} from './infrastructure';
import { resolvePersistentStorageRoot } from './storagePath';

export type Win10DeployPhaseStatus =
  | 'NOT_PREPARED'
  | 'DOWNLOADING'
  | 'VERIFYING'
  | 'EXTRACTING'
  | 'READY'
  | 'FAILED';

export interface Win10InstallerManifest {
  ready: boolean;
  edition: string;
  arch: 'x64';
  isoPath: string;
  isoSizeBytes: number;
  sha256Expected: string;
  sha256Actual: string;
  checksumVerified: boolean;
  extractedDir: string;
  extractionMode: 'full' | 'boot-payload-plus-shared-iso';
  extractedFilesCount: number;
  wimIndex: number;
  wimEdition: string;
  hypervisorMode: 'kvm' | 'tcg';
  storageType: 'persistent-volume' | 'workspace-data';
  preparedAt: string;
}

export interface Win10DeployState {
  status: Win10DeployPhaseStatus;
  stageDetail: string;
  ready: boolean;
  edition: string;
  arch: 'x64';
  stageIndex: number;
  totalStages: number;
  progressPercent: number;
  downloadedBytes: number;
  totalBytes: number;
  isoPath: string;
  extractedDir: string;
  sha256Expected?: string;
  sha256Actual?: string;
  checksumVerified: boolean;
  wimIndex?: number;
  wimEdition?: string;
  hypervisorMode: 'kvm' | 'tcg';
  storageType: 'persistent-volume' | 'workspace-data';
  storageRoot: string;
  availableStorageBytes: number;
  resumeMode?: 'fresh' | 'range-resume' | 'cached';
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  failedStage?: Win10DeployPhaseStatus;
  error?: string;
  remediation?: string;
  retryCount?: number;
  maxAutoRetries?: number;
  autoRetryScheduled?: boolean;
  nextRetryAt?: string;
  logs: string[];
}

export interface Win10AutoRetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
}

export const WIN10_AUTO_RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const WIN10_DEFAULT_MAX_AUTO_RETRIES = 10;

export function evaluateWin10AutoRetryPolicy(params: {
  errorMessage: string;
  failedStage: Win10DeployPhaseStatus;
  retryCount: number;
  maxAutoRetries?: number;
}): Win10AutoRetryDecision {
  const maxRetries = params.maxAutoRetries ?? WIN10_DEFAULT_MAX_AUTO_RETRIES;
  const msg = params.errorMessage || '';

  if (/INSUFFICIENT_DISK_SPACE|Không đủ dung lượng|ENOSPC/i.test(msg)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: 'Không đủ dung lượng lưu trữ/RAM khả dụng — cần giải phóng dung lượng trước khi tải lại.',
    };
  }

  if (params.retryCount >= maxRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: `Đã đạt giới hạn tự động thử lại (${maxRetries}/${maxRetries}); chờ khởi động lại server.`,
    };
  }

  const idx = Math.min(Math.max(0, Math.floor(params.retryCount)), WIN10_AUTO_RETRY_BACKOFF_MS.length - 1);
  const delayMs = WIN10_AUTO_RETRY_BACKOFF_MS[idx];
  const isChecksum = /SHA-256|CHECKSUM/i.test(msg);

  return {
    shouldRetry: true,
    delayMs,
    reason: isChecksum
      ? 'File ISO hỏng đã bị xóa tự động; hệ thống sẽ tự tải lại bản sạch từ nguồn chính thức.'
      : params.failedStage === 'NOT_PREPARED'
      ? 'Lỗi chuẩn bị môi trường/apt tạm thời; hệ thống sẽ tự động thử lại.'
      : 'Gián đoạn tải/chuẩn bị ISO; hệ thống sẽ tự động nối tải lại qua HTTP Range.',
  };
}

export interface Win10DeployDependencies {
  rootDir?: string;
  bakedRoot?: string;
  autoRetryEnabled?: boolean;
  maxAutoRetries?: number;
  autoRetryDelayMs?: (retryCount: number, defaultDelayMs: number) => number;
  ensureToolchain?: () => Promise<{ ok: boolean; reason?: string; has7z: boolean; hasQemu: boolean; hasOvmf: boolean }>;
  downloadIso?: (
    destPath: string,
    onProgress: (dl: {
      percent: number;
      downloadedBytes: number;
      totalBytes: number;
      provider: string;
      stage?: string;
      resumeMode?: 'fresh' | 'range-resume';
    }) => void
  ) => Promise<{
    isoPath: string;
    sizeBytes: number;
    expectedSha256: string;
    actualSha256?: string;
    checksumVerified: boolean;
    edition: string;
  }>;
  verifySha256?: (filePath: string) => Promise<string>;
  extractFiles?: (
    isoPath: string,
    targetDir: string,
    overlayMode: boolean
  ) => Promise<{
    extractedCount: number;
    mode: 'full' | 'boot-payload-plus-shared-iso';
    wimIndex: number;
    wimEdition: string;
  }>;
  getAvailableBytes?: (dir: string) => number;
  isOverlayFs?: () => boolean;
  hasKvm?: () => boolean;
  probeHost?: () => HostInfrastructureReport;
}

const WIN10_ISO_FILENAME = 'windows-10-iot-ltsc-2021-x64.iso';
const MIN_WIN10_ISO_BYTES = 500 * 1024 * 1024;
const TOTAL_PIPELINE_STAGES = 4; // DOWNLOADING -> VERIFYING -> EXTRACTING -> READY

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export class Win10DeployManager {
  private rootDir: string;
  private bakedRoot: string;
  private dataDir: string;
  private storageType: 'persistent-volume' | 'workspace-data';
  private isoDir: string;
  private installerDir: string;
  private extractedDir: string;
  private manifestPath: string;
  private statePath: string;
  private lockPath: string;
  private deps: Win10DeployDependencies;
  private state: Win10DeployState;
  private activePromise: Promise<Win10DeployState> | null = null;
  private autoRetryTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastHostReport?: HostInfrastructureReport;
  private readyListeners: Set<(state: Win10DeployState) => void> = new Set();

  constructor(deps: Win10DeployDependencies = {}) {
    this.deps = deps;
    this.rootDir = deps.rootDir || process.cwd();
    this.bakedRoot = deps.bakedRoot || '/opt/moon-studio/win10-baked';
    const storageLoc = resolvePersistentStorageRoot(
      deps.rootDir ? { workspaceRoot: deps.rootDir } : undefined
    );
    this.dataDir = storageLoc.dataDir;
    this.storageType = storageLoc.storageType;
    this.isoDir = path.join(this.dataDir, 'iso');
    this.installerDir = path.join(this.dataDir, 'installer', 'windows-10');
    this.extractedDir = path.join(this.installerDir, 'files');
    this.manifestPath = path.join(this.installerDir, 'manifest.json');
    this.statePath = path.join(this.installerDir, 'deploy-state.json');
    this.lockPath = path.join(this.installerDir, '.prepare.lock');

    try {
      fs.mkdirSync(this.isoDir, { recursive: true });
      fs.mkdirSync(this.extractedDir, { recursive: true });
    } catch {
      // ignore
    }

    const primaryMirror = DOCKUR_MIRROR_CATALOG['windows-10'][0];
    const hasKvm = this.checkHasKvm();
    const isoPath = path.join(this.isoDir, WIN10_ISO_FILENAME);
    const existingPartialBytes = this.findPartialDownloadBytes(isoPath);
    const expectedBytes = primaryMirror?.expectedSizeBytes || 4851668992;

    this.state = {
      status: 'NOT_PREPARED',
      stageDetail: existingPartialBytes > 0
        ? `Phát hiện bản tải dở (${(existingPartialBytes / (1024 * 1024)).toFixed(1)} MB) — chờ server khởi động để nối tải HTTP Range`
        : 'Chưa chuẩn bị — tự động chạy khi server khởi động',
      ready: false,
      edition: 'Windows 10 IoT Enterprise LTSC 2021 (x64)',
      arch: 'x64',
      stageIndex: 0,
      totalStages: TOTAL_PIPELINE_STAGES,
      progressPercent: existingPartialBytes > 0 && expectedBytes > 0
        ? Math.min(99, Math.round((existingPartialBytes / expectedBytes) * 1000) / 10)
        : 0,
      downloadedBytes: existingPartialBytes,
      totalBytes: expectedBytes,
      isoPath,
      extractedDir: this.extractedDir,
      sha256Expected: primaryMirror?.sha256,
      checksumVerified: false,
      hypervisorMode: hasKvm ? 'kvm' : 'tcg',
      storageType: this.storageType,
      storageRoot: this.dataDir,
      availableStorageBytes: 0,
      retryCount: 0,
      maxAutoRetries: deps.maxAutoRetries ?? WIN10_DEFAULT_MAX_AUTO_RETRIES,
      autoRetryScheduled: false,
      updatedAt: new Date().toISOString(),
      logs: [],
    };

    this.restoreReadyManifestIfValid();
  }

  private findPartialDownloadBytes(isoPath: string): number {
    try {
      const candidates = [
        ...DOCKUR_MIRROR_CATALOG['windows-10'].map((m) => `${isoPath}.${m.id}.downloading`),
        `${isoPath}.downloading`,
      ];
      let maxBytes = 0;
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const size = fs.statSync(cand).size;
          if (size > maxBytes) maxBytes = size;
        }
      }
      return maxBytes;
    } catch {
      return 0;
    }
  }

  private checkHasKvm(): boolean {
    if (this.deps.hasKvm) return this.deps.hasKvm();
    return fs.existsSync('/dev/kvm');
  }

  private appendLog(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.state.logs = [...this.state.logs.slice(-99), line];
    this.state.updatedAt = new Date().toISOString();
    if (level === 'error') {
      serverLogger.error('Win10DeployBoot', msg);
    } else if (level === 'warn') {
      serverLogger.warn('Win10DeployBoot', msg);
    } else {
      serverLogger.info('Win10DeployBoot', msg);
    }
    this.persistState();
  }

  private persistState(): void {
    if (this.disposed) return;
    try {
      fs.mkdirSync(this.installerDir, { recursive: true });
      const tmpState = `${this.statePath}.tmp`;
      fs.writeFileSync(tmpState, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmpState, this.statePath);
    } catch {
      // ignore
    }
  }

  private resolveManifestArtifacts(manifest: Win10InstallerManifest): Win10InstallerManifest | null {
    const isoCandidates = [
      manifest.isoPath,
      path.join(this.isoDir, WIN10_ISO_FILENAME),
      path.join(this.rootDir, 'data', 'iso', WIN10_ISO_FILENAME),
    ];
    const dirCandidates = [
      manifest.extractedDir,
      this.extractedDir,
      path.join(this.rootDir, 'data', 'installer', 'windows-10', 'files'),
    ];
    if (!this.deps.rootDir || this.deps.bakedRoot) {
      isoCandidates.push(path.join(this.bakedRoot, 'iso', WIN10_ISO_FILENAME));
      dirCandidates.push(path.join(this.bakedRoot, 'installer', 'windows-10', 'files'));
    }

    const resolvedIso = isoCandidates.find((p) => Boolean(p) && fs.existsSync(p));
    const resolvedDir = dirCandidates.find((p) => Boolean(p) && fs.existsSync(p) && countFilesRecursive(p) > 0);
    if (!resolvedIso || !resolvedDir) return null;

    return {
      ...manifest,
      isoPath: resolvedIso,
      extractedDir: resolvedDir,
    };
  }

  private readManifest(): Win10InstallerManifest | null {
    const candidates = [this.manifestPath];
    if (!this.deps.rootDir || this.deps.bakedRoot) {
      const workspaceManifest = path.join(this.rootDir, 'data', 'installer', 'windows-10', 'manifest.json');
      if (!candidates.includes(workspaceManifest)) {
        candidates.push(workspaceManifest);
      }
      const bakedManifest = path.join(this.bakedRoot, 'installer', 'windows-10', 'manifest.json');
      if (!candidates.includes(bakedManifest)) {
        candidates.push(bakedManifest);
      }
    }
    for (const cand of candidates) {
      try {
        if (!fs.existsSync(cand)) continue;
        const raw = JSON.parse(fs.readFileSync(cand, 'utf8'));
        if (raw && typeof raw === 'object' && raw.ready === true) {
          const resolved = this.resolveManifestArtifacts(raw as Win10InstallerManifest);
          if (resolved) return resolved;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  private restoreReadyManifestIfValid(): boolean {
    const manifest = this.readManifest();
    if (!manifest) return false;
    if (!manifest.isoPath || !fs.existsSync(manifest.isoPath)) return false;
    if (!manifest.checksumVerified || !manifest.sha256Actual) return false;
    if (manifest.sha256Expected && manifest.sha256Actual.toLowerCase() !== manifest.sha256Expected.toLowerCase()) {
      return false;
    }
    try {
      const stat = fs.statSync(manifest.isoPath);
      if (stat.size < MIN_WIN10_ISO_BYTES) return false;
      if (manifest.isoSizeBytes > 0 && Math.abs(stat.size - manifest.isoSizeBytes) > 1024 * 1024) {
        return false;
      }
    } catch {
      return false;
    }
    if (!manifest.extractedDir || !fs.existsSync(manifest.extractedDir)) return false;
    if (countFilesRecursive(manifest.extractedDir) <= 0) return false;

    this.state = {
      ...this.state,
      status: 'READY',
      stageDetail: 'Bộ cài Windows 10 IoT Enterprise LTSC 2021 đã sẵn sàng (SHA-256 verified)',
      ready: true,
      stageIndex: TOTAL_PIPELINE_STAGES,
      progressPercent: 100,
      downloadedBytes: manifest.isoSizeBytes,
      totalBytes: manifest.isoSizeBytes,
      isoPath: manifest.isoPath,
      extractedDir: manifest.extractedDir,
      sha256Expected: manifest.sha256Expected,
      sha256Actual: manifest.sha256Actual,
      checksumVerified: true,
      wimIndex: manifest.wimIndex,
      wimEdition: manifest.wimEdition,
      hypervisorMode: this.checkHasKvm() ? 'kvm' : 'tcg',
      storageType: this.storageType,
      storageRoot: this.dataDir,
      resumeMode: 'cached',
      completedAt: manifest.preparedAt,
      updatedAt: new Date().toISOString(),
      error: undefined,
      failedStage: undefined,
      remediation: undefined,
    };
    return true;
  }

  public getState(): Win10DeployState {
    return { ...this.state, logs: [...this.state.logs] };
  }

  public isReady(): boolean {
    return this.state.status === 'READY' && this.state.ready === true;
  }

  public getPreparedArtifact(): Win10InstallerManifest | null {
    if (!this.isReady()) return null;
    const manifest = this.readManifest();
    if (manifest && fs.existsSync(manifest.isoPath)) {
      return manifest;
    }
    return null;
  }

  private acquireFileLock(): boolean {
    try {
      fs.mkdirSync(this.installerDir, { recursive: true });
      if (fs.existsSync(this.lockPath)) {
        try {
          const lockRaw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number; startedAt?: string };
          if (typeof lockRaw.pid === 'number' && lockRaw.pid !== process.pid && isProcessAlive(lockRaw.pid)) {
            this.appendLog(
              `Phát hiện tiến trình chuẩn bị ISO khác đang chạy (PID=${lockRaw.pid}), ngăn chạy trùng lặp.`,
              'warn'
            );
            return false;
          }
          // Stale lock from previous crashed server process — safe to clean up
          fs.unlinkSync(this.lockPath);
        } catch {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // ignore
          }
        }
      }
      fs.writeFileSync(
        this.lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { encoding: 'utf8', flag: 'wx' }
      );
      return true;
    } catch {
      return false;
    }
  }

  private releaseFileLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        const lockRaw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number };
        if (!lockRaw.pid || lockRaw.pid === process.pid) {
          fs.unlinkSync(this.lockPath);
        }
      }
    } catch {
      // ignore
    }
  }

  public onReady(listener: (state: Win10DeployState) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  private emitReady(): void {
    const snapshot = this.getState();
    for (const listener of this.readyListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        serverLogger.warn('Win10DeployBoot', `onReady listener error: ${err}`);
      }
    }
  }

  public clearAutoRetryTimer(): void {
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer);
      this.autoRetryTimer = null;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.clearAutoRetryTimer();
    this.readyListeners.clear();
  }

  /**
   * Executed automatically during SERVER STARTUP / APPLICATION BOOT.
   * Deduplicated via in-memory activePromise + PID lockfile.
   * Never blocks Express HTTP server startup.
   */
  public startBackgroundPreparation(options?: { hostReport?: HostInfrastructureReport }): Promise<Win10DeployState> {
    if (options?.hostReport) {
      this.lastHostReport = options.hostReport;
    }
    if (this.activePromise) {
      return this.activePromise;
    }
    this.clearAutoRetryTimer();
    this.state.autoRetryScheduled = false;
    this.state.nextRetryAt = undefined;
    this.activePromise = this.runStartupPreparationPipeline(options?.hostReport || this.lastHostReport).finally(() => {
      this.activePromise = null;
    });
    return this.activePromise;
  }

  public retryPreparation(options?: { hostReport?: HostInfrastructureReport }): Promise<Win10DeployState> {
    if (this.activePromise) {
      return this.activePromise;
    }
    this.clearAutoRetryTimer();
    this.state.autoRetryScheduled = false;
    this.state.nextRetryAt = undefined;
    this.state.error = undefined;
    this.state.failedStage = undefined;
    this.state.remediation = undefined;
    this.setStage('NOT_PREPARED', 0, 'Đang tự động khởi chạy lại chuẩn bị bộ cài Windows 10...');
    this.appendLog('Khởi chạy lại quy trình chuẩn bị bộ cài Windows 10 IoT Enterprise LTSC 2021 (Server Startup Recovery).');
    return this.startBackgroundPreparation(options);
  }

  private scheduleAutoRetry(failedStage: Win10DeployPhaseStatus, errorMessage: string): void {
    if (this.disposed || this.deps.autoRetryEnabled === false) return;
    this.clearAutoRetryTimer();

    const currentRetries = this.state.retryCount ?? 0;
    const maxRetries = this.deps.maxAutoRetries ?? this.state.maxAutoRetries ?? WIN10_DEFAULT_MAX_AUTO_RETRIES;
    const policy = evaluateWin10AutoRetryPolicy({
      errorMessage,
      failedStage,
      retryCount: currentRetries,
      maxAutoRetries: maxRetries,
    });

    this.state.maxAutoRetries = maxRetries;
    if (!policy.shouldRetry) {
      this.state.autoRetryScheduled = false;
      this.state.nextRetryAt = undefined;
      this.state.remediation = policy.reason;
      this.persistState();
      return;
    }

    const effectiveDelayMs = Math.max(
      1,
      this.deps.autoRetryDelayMs
        ? this.deps.autoRetryDelayMs(currentRetries, policy.delayMs)
        : policy.delayMs
    );
    const nextAttemptNumber = currentRetries + 1;
    const nextRetryAt = new Date(Date.now() + effectiveDelayMs).toISOString();
    const delayLabel =
      effectiveDelayMs >= 1000
        ? `${Math.ceil(effectiveDelayMs / 1000)} giây`
        : `${effectiveDelayMs}ms`;

    this.state.autoRetryScheduled = true;
    this.state.nextRetryAt = nextRetryAt;
    this.state.remediation = `${policy.reason} Hệ thống tự động thử tải lại (lần ${nextAttemptNumber}/${maxRetries}) sau ${delayLabel}.`;
    this.appendLog(
      `[Auto-Retry] Lên lịch tự động tải lại Windows 10 (lần ${nextAttemptNumber}/${maxRetries}) sau ${delayLabel} (HTTP Range resume).`,
      'warn'
    );

    this.autoRetryTimer = setTimeout(() => {
      this.autoRetryTimer = null;
      if (this.disposed || this.isReady()) return;
      this.state.retryCount = nextAttemptNumber;
      this.state.autoRetryScheduled = false;
      this.state.nextRetryAt = undefined;
      void this.retryPreparation({ hostReport: this.lastHostReport });
    }, effectiveDelayMs);
    this.autoRetryTimer.unref?.();
  }

  private setStage(
    status: Win10DeployPhaseStatus,
    stageIndex: number,
    stageDetail: string,
    progressPercent?: number
  ): void {
    this.state.status = status;
    this.state.stageIndex = stageIndex;
    this.state.stageDetail = stageDetail;
    this.state.ready = status === 'READY';
    if (typeof progressPercent === 'number') {
      this.state.progressPercent = progressPercent;
    }
    this.state.updatedAt = new Date().toISOString();
    this.persistState();
  }

  private async runStartupPreparationPipeline(hostReport?: HostInfrastructureReport): Promise<Win10DeployState> {
    // Fast-path: already prepared and verified from previous boot on persistent/shared storage
    if (this.restoreReadyManifestIfValid()) {
      this.appendLog(
        `[Startup 4/8] Phát hiện bộ cài Windows 10 IoT Enterprise LTSC 2021 đã READY từ lần khởi động trước (${this.state.isoPath}, SHA-256 verified) — không tải lại, không giải nén lại.`
      );
      this.emitReady();
      return this.getState();
    }

    if (!this.acquireFileLock()) {
      return this.getState();
    }

    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    let currentStage: Win10DeployPhaseStatus = 'NOT_PREPARED';

    try {
      // ==================== BOOT STEP 3: HostInspector Check ====================
      const report =
        hostReport ||
        (this.deps.probeHost ? this.deps.probeHost() : this.deps.rootDir ? null : probeHostInfrastructure({ skipNetworkLookup: true }));

      for (const dir of [this.isoDir, this.installerDir, this.extractedDir, path.join(this.dataDir, 'disks')]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
      }

      const availBytes = this.deps.getAvailableBytes
        ? this.deps.getAvailableBytes(this.isoDir)
        : getAvailableDiskBytes(this.isoDir);
      this.state.availableStorageBytes = availBytes;

      const overlay = this.deps.isOverlayFs ? this.deps.isOverlayFs() : isMemoryBackedOverlayfs();
      const hasKvm = report ? report.virtualization.kvmAvailable : this.checkHasKvm();
      this.state.hypervisorMode = hasKvm ? 'kvm' : 'tcg';

      const cpuCoresLabel = report ? `${report.cpu.cores} cores` : 'host CPU';
      const ramLabel = report ? report.memory.totalFormatted : 'host RAM';
      this.appendLog(
        `[Startup 3/8] HostInspector: CPU=${cpuCoresLabel}, RAM=${ramLabel}, Hypervisor=${hasKvm ? '/dev/kvm' : 'QEMU TCG (no /dev/kvm)'}, Storage=${this.storageType} (${overlay ? 'RAM-backed overlayfs' : 'disk'}, trống ${(availBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB).`
      );

      // Ensure QEMU, OVMF, 7z toolchain on host before ISO preparation
      const toolchain = this.deps.ensureToolchain
        ? await this.deps.ensureToolchain()
        : await this.defaultEnsureToolchain();
      if (!toolchain.ok) {
        throw new Error(toolchain.reason || 'Thiếu công cụ QEMU / OVMF / 7z cần thiết để chuẩn bị và chạy Windows 10.');
      }

      const isoPath = this.state.isoPath;
      const primaryMirror = DOCKUR_MIRROR_CATALOG['windows-10'][0];
      let expectedSha256 = primaryMirror?.sha256 || '';
      let editionLabel = primaryMirror?.edition || 'Windows 10 IoT Enterprise LTSC 2021 (x64)';

      // ==================== BOOT STEP 4 & 5: Check existing ISO -> Download/Resume ====================
      let needDownload = true;
      let preExistingIsoChecked = false;
      if (this.hasPlausibleIsoFile(isoPath)) {
        const sizeBytes = fs.statSync(isoPath).size;
        const matched = DOCKUR_MIRROR_CATALOG['windows-10'].find(
          (m) => Math.abs(m.expectedSizeBytes - sizeBytes) <= 2 * 1024 * 1024
        );
        // When not running mock tests, verify file matches expected official byte size
        const sizeLooksValid = Boolean(matched) || Boolean(this.deps.downloadIso);
        if (sizeLooksValid) {
          if (matched?.sha256) {
            expectedSha256 = matched.sha256;
            editionLabel = matched.edition;
          }
          currentStage = 'VERIFYING';
          this.setStage('VERIFYING', 2, 'Phát hiện ISO sẵn có — đang kiểm tra SHA-256...', 100);
          this.state.downloadedBytes = sizeBytes;
          this.state.totalBytes = sizeBytes;
          this.state.sha256Expected = expectedSha256;
          this.appendLog(`[Startup 4/8] Phát hiện ISO tại ${isoPath} (${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB), kiểm tra SHA-256 trước khi quyết định tái sử dụng...`);

          const preSha = this.deps.verifySha256 ? await this.deps.verifySha256(isoPath) : await computeFileSha256(isoPath);
          const preCheck = evaluateIsoChecksum(preSha, expectedSha256);
          if (preCheck.verified) {
            this.state.sha256Actual = preSha;
            this.state.checksumVerified = true;
            this.state.resumeMode = 'cached';
            needDownload = false;
            preExistingIsoChecked = true;
            this.appendLog(`[Startup 6/8] ISO trên đĩa hợp lệ (SHA-256: ${preSha}) — bỏ qua tải lại.`);
          } else {
            this.appendLog(
              `[Startup 4/8] ISO hiện có bị hỏng (${preCheck.reason}) — xóa file lỗi và tự động tải lại từ nguồn chính thức.`,
              'warn'
            );
            try {
              fs.unlinkSync(isoPath);
            } catch {
              // ignore
            }
          }
        } else {
          this.appendLog(
            `[Startup 4/8] Phát hiện file ISO kích thước không khớp (${sizeBytes} B) — xóa file lỗi để tải lại bản chính thức.`,
            'warn'
          );
          try {
            fs.unlinkSync(isoPath);
          } catch {
            // ignore
          }
        }
      }

      if (needDownload) {
        const partialBytes = this.findPartialDownloadBytes(isoPath);
        const minNeededBytes = (primaryMirror?.expectedSizeBytes || 4851668992) + 512 * 1024 * 1024;
        if (availBytes > 0 && availBytes + partialBytes < minNeededBytes) {
          throw new Error(
            `Không đủ dung lượng lưu trữ để tải & chuẩn bị Windows 10 IoT Enterprise LTSC 2021 ISO (cần ${(minNeededBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB, còn trống ${((availBytes + partialBytes) / (1024 * 1024 * 1024)).toFixed(2)} GiB).`
          );
        }

        currentStage = 'DOWNLOADING';
        const initialPct =
          partialBytes > 0 && (primaryMirror?.expectedSizeBytes || 0) > 0
            ? Math.min(99, Math.round((partialBytes / primaryMirror.expectedSizeBytes) * 1000) / 10)
            : 0;
        this.state.resumeMode = partialBytes > 0 ? 'range-resume' : 'fresh';
        this.setStage(
          'DOWNLOADING',
          1,
          partialBytes > 0
            ? `Đang tiếp tục tải ISO qua HTTP Range từ ${(partialBytes / (1024 * 1024)).toFixed(0)} MB...`
            : `Đang tải ${editionLabel} từ nguồn chính thức...`,
          initialPct
        );
        this.appendLog(
          partialBytes > 0
            ? `[Startup 5/8] DOWNLOADING: phát hiện ${(partialBytes / (1024 * 1024)).toFixed(1)} MiB tải dở, tiếp tục tải ${editionLabel} bằng HTTP Range...`
            : `[Startup 5/8] DOWNLOADING: bắt đầu tải ${editionLabel} từ nguồn chính thức...`
        );

        let lastLoggedPct = -10;
        const onDlProgress = (dl: {
          percent: number;
          downloadedBytes: number;
          totalBytes: number;
          provider: string;
          stage?: string;
          resumeMode?: 'fresh' | 'range-resume';
        }) => {
          this.state.downloadedBytes = dl.downloadedBytes;
          this.state.totalBytes = dl.totalBytes;
          this.state.progressPercent = dl.percent;
          if (dl.resumeMode) {
            this.state.resumeMode = dl.resumeMode;
          }
          if (dl.stage === 'verifying') {
            currentStage = 'VERIFYING';
            this.state.status = 'VERIFYING';
            this.state.stageIndex = 2;
            this.state.stageDetail = 'Đang xác minh mã băm SHA-256 cho ISO...';
          }
          this.state.updatedAt = new Date().toISOString();
          if (dl.percent - lastLoggedPct >= 10) {
            lastLoggedPct = dl.percent;
            const dlMb = (dl.downloadedBytes / (1024 * 1024)).toFixed(0);
            const totMb = (dl.totalBytes / (1024 * 1024)).toFixed(0);
            this.appendLog(`Đang tải Windows 10 IoT LTSC 2021 ISO: ${dlMb}/${totMb} MB (${dl.percent}%)`);
          }
        };

        const dlResult = this.deps.downloadIso
          ? await this.deps.downloadIso(isoPath, onDlProgress)
          : await this.defaultDownloadIso(isoPath, onDlProgress);

        expectedSha256 = dlResult.expectedSha256 || expectedSha256;
        editionLabel = dlResult.edition || editionLabel;
        this.state.downloadedBytes = dlResult.sizeBytes;
        this.state.totalBytes = dlResult.sizeBytes;
        if (dlResult.actualSha256) {
          this.state.sha256Actual = dlResult.actualSha256;
        }
        this.appendLog(`[Startup 5/8] Hoàn tất tải ISO (${(dlResult.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB).`);
      }

      // ==================== BOOT STEP 6: VERIFYING SHA-256 ====================
      if (!preExistingIsoChecked) {
        currentStage = 'VERIFYING';
        this.setStage('VERIFYING', 2, 'Đang kiểm tra SHA-256 và tính toàn vẹn ISO...', 100);
        this.state.sha256Expected = expectedSha256;
        this.appendLog(`[Startup 6/8] VERIFYING: đang kiểm tra mã băm SHA-256 và cấu trúc cài đặt...`);

        const actualSha256 =
          this.state.sha256Actual ||
          (this.deps.verifySha256 ? await this.deps.verifySha256(isoPath) : await computeFileSha256(isoPath));
        const checksumCheck = evaluateIsoChecksum(actualSha256, expectedSha256);
        if (!checksumCheck.verified) {
          try {
            if (fs.existsSync(isoPath)) fs.unlinkSync(isoPath);
          } catch {
            // ignore
          }
          this.state.checksumVerified = false;
          this.state.sha256Actual = actualSha256;
          throw new Error(`Xác minh SHA-256 thất bại cho ISO: ${checksumCheck.reason}`);
        }

        this.state.sha256Actual = actualSha256;
        this.state.checksumVerified = true;
        this.appendLog(`[Startup 6/8] Xác minh SHA-256 thành công: ${actualSha256}`);
      }

      // ==================== BOOT STEP 7: EXTRACTING & PREPARING ====================
      currentStage = 'EXTRACTING';
      this.setStage('EXTRACTING', 3, 'Đang giải nén các thành phần cài đặt Windows 10...', 100);
      this.appendLog(`[Startup 7/8] EXTRACTING: giải nén file cài đặt Windows 10 vào ${this.extractedDir}...`);

      const extractResult = this.deps.extractFiles
        ? await this.deps.extractFiles(isoPath, this.extractedDir, overlay)
        : await this.defaultExtractFiles(isoPath, this.extractedDir, overlay);

      if (extractResult.extractedCount <= 0) {
        throw new Error('Không giải nén được tệp khởi động/cài đặt từ ISO Windows 10 IoT Enterprise LTSC 2021.');
      }

      this.state.wimIndex = extractResult.wimIndex;
      this.state.wimEdition = extractResult.wimEdition;
      this.appendLog(
        `[Startup 7/8] Đã chuẩn bị ${extractResult.extractedCount} tệp cài đặt (mode=${extractResult.mode}, WIM index=${extractResult.wimIndex} [${extractResult.wimEdition}]).`
      );

      // Write manifest atomically
      const isoSizeBytes = fs.statSync(isoPath).size;
      const now = new Date().toISOString();
      const manifest: Win10InstallerManifest = {
        ready: true,
        edition: editionLabel,
        arch: 'x64',
        isoPath,
        isoSizeBytes,
        sha256Expected: expectedSha256,
        sha256Actual: this.state.sha256Actual || expectedSha256,
        checksumVerified: true,
        extractedDir: this.extractedDir,
        extractionMode: extractResult.mode,
        extractedFilesCount: extractResult.extractedCount,
        wimIndex: extractResult.wimIndex,
        wimEdition: extractResult.wimEdition,
        hypervisorMode: hasKvm ? 'kvm' : 'tcg',
        storageType: this.storageType,
        preparedAt: now,
      };
      const tmpManifest = `${this.manifestPath}.tmp`;
      fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf8');
      fs.renameSync(tmpManifest, this.manifestPath);

      // ==================== BOOT STEP 8: READY ====================
      this.clearAutoRetryTimer();
      this.state.completedAt = now;
      this.state.error = undefined;
      this.state.failedStage = undefined;
      this.state.remediation = undefined;
      this.state.autoRetryScheduled = false;
      this.state.nextRetryAt = undefined;
      this.setStage(
        'READY',
        TOTAL_PIPELINE_STAGES,
        `Bộ cài ${editionLabel} đã READY — tạo Windows VM không cần tải lại ISO`,
        100
      );
      this.appendLog(`[Startup 8/8] Windows installer READY — ${editionLabel} đã sẵn sàng phục vụ tạo máy ảo.`);
      this.emitReady();
      return this.getState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.ready = false;
      this.state.failedStage = currentStage;
      this.state.status = 'FAILED';
      this.state.stageDetail = `Chuẩn bị thất bại tại bước ${currentStage}`;
      this.state.error = msg;
      this.state.remediation = this.suggestRemediation(currentStage, msg);
      this.appendLog(`Startup preparation FAILED tại bước "${currentStage}": ${msg}`, 'error');
      this.scheduleAutoRetry(currentStage, msg);
      return this.getState();
    } finally {
      this.releaseFileLock();
    }
  }

  private hasPlausibleIsoFile(isoPath: string): boolean {
    if (!fs.existsSync(isoPath)) return false;
    try {
      const stat = fs.statSync(isoPath);
      return stat.size >= MIN_WIN10_ISO_BYTES;
    } catch {
      return false;
    }
  }

  private suggestRemediation(stage: Win10DeployPhaseStatus, msg: string): string {
    if (msg.includes('SHA-256') || msg.includes('CHECKSUM')) {
      return 'File ISO bị hỏng đã được xóa tự động; hệ thống sẽ tải lại từ nguồn chính thức khi server khởi động lại.';
    }
    if (msg.includes('dung lượng') || msg.includes('ENOSPC')) {
      return 'Giải phóng thêm dung lượng/RAM trống trên máy chủ và khởi động lại server để hoàn tất tải ISO.';
    }
    if (stage === 'NOT_PREPARED') {
      return 'Kiểm tra kết nối apt/mạng và quyền ghi thư mục lưu trữ trước khi khởi động lại server.';
    }
    return 'Khởi động lại server để tiếp tục tải phần ISO còn lại qua HTTP Range.';
  }

  private async defaultEnsureToolchain(): Promise<{
    ok: boolean;
    reason?: string;
    has7z: boolean;
    hasQemu: boolean;
    hasOvmf: boolean;
  }> {
    const checkBins = () => {
      const has7z = fs.existsSync('/usr/bin/7z') || fs.existsSync('/usr/bin/7za');
      const hasQemu = fs.existsSync('/usr/bin/qemu-system-x86_64') && fs.existsSync('/usr/bin/qemu-img');
      const ovmf = resolveOvmfPaths();
      const hasOvmf = Boolean(ovmf.codePath && ovmf.varsPath);
      return { has7z, hasQemu, hasOvmf };
    };

    let current = checkBins();
    if (current.has7z && current.hasQemu && current.hasOvmf) {
      return { ok: true, ...current };
    }

    const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
    if (isRoot && fs.existsSync('/usr/bin/apt-get')) {
      this.appendLog('Thiếu QEMU / OVMF / 7z trên host — đang tự động cài đặt gói hệ thống ở chế độ nền...');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          'bash',
          [
            '-lc',
            'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -o DPkg::Lock::Timeout=120 --no-install-recommends qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools genisoimage p7zip-full && apt-get clean && rm -rf /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial/*',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let errTail = '';
        proc.stderr?.on('data', (d) => {
          errTail = `${errTail}${d.toString()}`.slice(-600);
        });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`apt-get exited with code ${code}: ${errTail.trim()}`));
        });
      });
      current = checkBins();
    }

    if (!current.hasQemu || !current.hasOvmf || !current.has7z) {
      return {
        ok: false,
        ...current,
        reason: `Thiếu công cụ bắt buộc trên host (qemu=${current.hasQemu}, ovmf=${current.hasOvmf}, 7z=${current.has7z}).`,
      };
    }
    return { ok: true, ...current };
  }

  private async defaultDownloadIso(
    destPath: string,
    onProgress: (dl: {
      percent: number;
      downloadedBytes: number;
      totalBytes: number;
      provider: string;
      stage?: string;
      resumeMode?: 'fresh' | 'range-resume';
    }) => void
  ): Promise<{
    isoPath: string;
    sizeBytes: number;
    expectedSha256: string;
    actualSha256?: string;
    checksumVerified: boolean;
    edition: string;
  }> {
    const mirror = await dockurEngine.downloadIsoAutomatically('windows-10', destPath, (dl) => {
      onProgress({
        percent: dl.percent,
        downloadedBytes: dl.downloadedBytes,
        totalBytes: dl.totalBytes,
        provider: dl.provider,
        stage: dl.stage,
        resumeMode: dl.resumeMode,
      });
    });
    const sizeBytes = fs.existsSync(destPath) ? fs.statSync(destPath).size : mirror.expectedSizeBytes;
    return {
      isoPath: destPath,
      sizeBytes,
      expectedSha256: mirror.sha256 || '',
      actualSha256: mirror.sha256Actual,
      checksumVerified: Boolean(mirror.checksumVerified),
      edition: mirror.edition,
    };
  }

  private async defaultExtractFiles(
    isoPath: string,
    targetDir: string,
    overlayMode: boolean
  ): Promise<{
    extractedCount: number;
    mode: 'full' | 'boot-payload-plus-shared-iso';
    wimIndex: number;
    wimEdition: string;
  }> {
    const sevenZ = fs.existsSync('/usr/bin/7z') ? '/usr/bin/7z' : fs.existsSync('/usr/bin/7za') ? '/usr/bin/7za' : null;
    if (!sevenZ) {
      throw new Error('Không tìm thấy 7z (/usr/bin/7z) để giải nén file cài đặt ISO.');
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const availBytes = getAvailableDiskBytes(targetDir);
    const extractFull = !overlayMode && availBytes > 10 * 1024 * 1024 * 1024;
    const patterns = extractFull
      ? []
      : ['boot/*', 'efi/*', 'setup.exe', 'autorun.inf', 'sources/boot.wim', 'sources/lang.ini', 'sources/ei.cfg'];

    const args = ['x', '-y', `-o${targetDir}`, isoPath, ...patterns];
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(sevenZ, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errTail = '';
      proc.stderr?.on('data', (d) => {
        errTail = `${errTail}${d.toString()}`.slice(-600);
      });
      proc.on('error', (e) => reject(e));
      proc.on('close', (code) => {
        if (code === 0 || code === 1) resolve();
        else reject(new Error(`7z extract failed with code ${code}: ${errTail.trim()}`));
      });
    });

    const extractedCount = countFilesRecursive(targetDir);
    const { wimIndex, wimEdition } = inspectWin10IoTWimIndex(isoPath);
    return {
      extractedCount,
      mode: extractFull ? 'full' : 'boot-payload-plus-shared-iso',
      wimIndex,
      wimEdition,
    };
  }
}

export function countFilesRecursive(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursive(full);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

export function inspectWin10IoTWimIndex(isoPath: string): { wimIndex: number; wimEdition: string } {
  try {
    const fd = fs.openSync(isoPath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const chunkSize = 4 * 1024 * 1024;
      const overlap = 16;
      const buf = Buffer.allocUnsafe(chunkSize + overlap);
      const magic = Buffer.from([0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00]); // "MSWIM\0\0\0"
      const headerBuf = Buffer.allocUnsafe(208);

      let offset = 0;
      let carry = 0;
      while (offset < stat.size) {
        const toRead = Math.min(chunkSize, stat.size - offset);
        const bytesRead = fs.readSync(fd, buf, carry, toRead, offset);
        if (bytesRead <= 0) break;
        const windowLen = carry + bytesRead;

        let searchFrom = 0;
        while (searchFrom < windowLen) {
          const idx = buf.indexOf(magic, searchFrom);
          if (idx < 0) break;
          const absPos = offset - carry + idx;
          if (absPos % 2048 === 0 && absPos + 208 <= stat.size) {
            fs.readSync(fd, headerBuf, 0, 208, absPos);
            const cbSize = headerBuf.readUInt32LE(8);
            const imageCount = headerBuf.readUInt32LE(44);
            const xmlFlagsAndSize = headerBuf.readBigUInt64LE(72);
            const xmlOffset = Number(headerBuf.readBigUInt64LE(80));
            const xmlSize = Number(xmlFlagsAndSize & 0x00ffffffffffffffn);

            if (cbSize === 208 && imageCount >= 1 && xmlSize > 64 && xmlSize < 512 * 1024 && absPos + xmlOffset + xmlSize <= stat.size) {
              const xmlRaw = Buffer.allocUnsafe(xmlSize);
              fs.readSync(fd, xmlRaw, 0, xmlSize, absPos + xmlOffset);
              const xmlText = xmlRaw.toString('utf16le');
              if (xmlText.includes('<INSTALLATIONTYPE>Client</INSTALLATIONTYPE>') || xmlText.includes('<NAME>Windows 10')) {
                const matches = Array.from(xmlText.matchAll(/<IMAGE INDEX="(\d+)">[\s\S]*?<NAME>([^<]+)<\/NAME>/gi));
                if (matches.length > 0) {
                  const iotLtsc = matches.find((m) => /iot.*ltsc/i.test(m[2]));
                  if (iotLtsc) return { wimIndex: Number(iotLtsc[1]), wimEdition: iotLtsc[2].trim() };
                  const ltsc = matches.find((m) => /ltsc/i.test(m[2]));
                  if (ltsc) return { wimIndex: Number(ltsc[1]), wimEdition: ltsc[2].trim() };
                  const ent = matches.find((m) => /enterprise/i.test(m[2]));
                  if (ent) return { wimIndex: Number(ent[1]), wimEdition: ent[2].trim() };
                  return { wimIndex: Number(matches[0][1]) || 1, wimEdition: matches[0][2].trim() };
                }
              }
            }
          }
          searchFrom = idx + 8;
        }
        const tail = Math.min(overlap, windowLen);
        buf.copy(buf, 0, windowLen - tail, windowLen);
        carry = tail;
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return { wimIndex: 1, wimEdition: 'Windows 10 IoT Enterprise LTSC' };
}

void execFileSync;

export const win10DeployManager = new Win10DeployManager();
