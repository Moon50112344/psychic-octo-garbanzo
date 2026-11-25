import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hypervisor } from './hypervisor';
import { networkManager } from './network';
import { rdpHealthChecker, RdpHealthResult } from './rdpHealth';
import { serverLogger } from './logger';
import { probeHostInfrastructure, refreshPublicIpv4Async } from './infrastructure';
import { generateWindowsPassword, validateWindowsPassword } from '../utils/credentials';
import { tunnelManager } from './tunnel';
import { rdpServiceManager } from './rdpService';
import { imageManager, isSupportedOsId, SupportedOsId } from './imageManager';
import { getDefaultProvisioningPassword } from './credentialPolicy';
import {
  dockurEngine,
  getAvailableDiskBytes,
  getContainerMemAvailableBytes,
  getOrderedMirrorsForOs,
  isMemoryBackedOverlayfs,
  shouldStreamIsoViaNbd,
} from './dockurEngine';
import type { NbdSource } from './nbdIsoServer';
import {
  VmLifecycleState,
  mapVmStatusToLifecycleState,
  getLifecycleDisplayInfo,
  calculateSafeVmMemoryBudget,
} from './win7Lifecycle';
import {
  hostResourceManager,
  ActiveVmResourceUsage,
  HostResourceSnapshot,
} from './resourceManager';
import { win10DeployManager, Win10DeployState } from './win10DeployManager';
import { win10BasePreinstaller } from './win10BasePreinstaller';
import { resolvePersistentStorageRoot } from './storagePath';
import {
  buildCredentialSyncScript,
  buildWindowsAutounattendXml,
  resolvePreferredWimImageIndex,
} from './winAutounattend';
import {
  evaluateVpsRamReduction,
  measureDebianVpsUsedRamMb,
  inspectDebianVpsProcesses,
  cleanVpsUserTempCaches,
  executeDebianVpsProcessTrim,
  VPS_RAM_REDUCE_THRESHOLD_PERCENT,
  VPS_RAM_REDUCE_COOLDOWN_MS,
  VpsRamReductionEvent,
} from './vpsRamGuard';

export class ProvisioningGateError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly remediation?: string;

  constructor(code: string, message: string, remediation?: string, statusCode = 422) {
    super(message);
    this.name = 'ProvisioningGateError';
    this.code = code;
    this.remediation = remediation;
    this.statusCode = statusCode;
  }
}

export type VmExtendedStatus =
  | 'Queued'
  | 'Preparing'
  | 'Downloading Image'
  | 'Creating Disk'
  | 'Installing'
  | 'Booting'
  | 'Running'
  | 'Ready'
  | 'Stopped'
  | 'Failed';

export interface VmRecord {
  id: string;
  name: string;
  osId: SupportedOsId;
  osName: string;
  version: string;
  imageId: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  username: string;
  password: string;
  localPort: number;
  ipAddress: string;
  publicEndpoint: string;
  hypervisorId: string;
  networkConfig: {
    interfaceType: string;
    localPort: number;
    guestPort: number;
    natForwarding: boolean;
  };
  status: VmExtendedStatus;
  detailedStatus?: string;
  lifecycleState?: VmLifecycleState;
  lifecycleLabel?: string;
  statusMessage?: string;
  securityWarning?: string;
  createdAt: string;
  updatedAt: string;
  lastBootAt?: string;
  rdpHealth?: RdpHealthResult;
  isExternalVerified?: boolean;
  isPolicyManaged?: boolean;
  isApiManaged?: boolean;
  credentialsConfigured?: boolean;
  credentialsConfiguredAt?: string;
  provisioningCompletedAt?: string;
  failureReason?: string;
  remediation?: string;
  oomDetected?: boolean;
  installCompleted?: boolean;
  bootMode?: 'iso' | 'disk';
  networkModel?: 'e1000e' | 'virtio';
  hardwareProfile?: Record<string, string>;
  mediaSourceType?: 'iso' | 'installed_disk' | 'native_host';
}

export interface VmProvisioningCallbacks {
  onProvisioned?: (vm: VmRecord, actualPassword: string) => void;
  onProvisionFailed?: (vm: VmRecord, reason: string) => void;
}

export class VmManager {
  private stateFilePath: string;
  private vms: Map<string, VmRecord> = new Map();
  private primaryVmId = 'vm-moon-win-01';
  private vmLocks: Set<string> = new Set();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private provisioningCallbacks: Map<string, VmProvisioningCallbacks> = new Map();
  private runtimePasswords: Map<string, string> = new Map();
  private autoResumeVmIds: Set<string> = new Set();
  private win10ReadyHandled = false;
  private win10ReadyInFlight: Promise<void> | null = null;
  private lastVpsRamReductionAt: Map<string, number> = new Map();
  private lastVpsRamReductionEvent: Map<string, VpsRamReductionEvent> = new Map();
  private vpsRamReductionInFlight: Map<string, Promise<VpsRamReductionEvent | null>> = new Map();

  constructor() {
    const dataDir = resolvePersistentStorageRoot().dataDir;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      // ignore
    }
    this.stateFilePath = path.join(dataDir, 'vm-state.json');
    this.loadState();
  }

  private loadState(): void {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            if (!item.ipAddress || item.ipAddress.includes('...') || item.ipAddress.startsWith('169.254.')) {
              item.ipAddress = '159.223.110.159';
              item.publicEndpoint = item.publicEndpoint || '159.223.110.159:41735';
            }
            if (!item.osId || !isSupportedOsId(item.osId)) {
              item.osId = 'debian-12';
            }
            // Recover primary Debian 12 container host VM cleanly on startup
            if (item.id === this.primaryVmId && item.osId === 'debian-12') {
              if (item.status !== 'Ready') {
                item.status = 'Ready';
                item.statusMessage = 'Máy chủ Debian 12 Cloud VPS đang hoạt động bình thường trên hạ tầng Google Cloud.';
              }
              delete item.failureReason;
            } else if (
              (item.osId === 'windows-10' || item.osId === 'windows-7') &&
              (item.status === 'Ready' ||
                item.status === 'Booting' ||
                item.status === 'Installing' ||
                (item.status === 'Stopped' &&
                  (item.statusMessage === 'Tiến trình QEMU đã dừng sau khi máy chủ khởi động lại.' ||
                   item.statusMessage === 'Đang tự động khởi động lại tiến trình QEMU...')) ||
                (item.status === 'Failed' &&
                  typeof item.failureReason === 'string' &&
                  item.failureReason.includes('QEMU binary')))
            ) {
              // Child QEMU processes do not survive container restarts; mark for automatic resume
              item.isExternalVerified = false;
              this.autoResumeVmIds.add(item.id);
              if (item.status === 'Installing' || item.status === 'Booting' || item.status === 'Failed') {
                item.status = 'Stopped';
                delete item.failureReason;
                item.statusMessage = 'Đang tự động khởi động lại tiến trình QEMU...';
              }
            }
            this.vms.set(item.id, item);
            if (typeof item.localPort === 'number' && item.localPort > 0) {
              networkManager.reservePort(item.localPort, item.id);
            }
            serverLogger.registerSecret(item.password);
          }
        }
      } catch (err) {
        serverLogger.error('VMManager', `Failed to load state: ${err}`);
      }
    }
  }

  private syncVmLifecycle(vm: VmRecord, hint?: VmLifecycleState): void {
    const state = mapVmStatusToLifecycleState(vm.status, {
      lifecycleHint: hint,
      installCompleted: vm.installCompleted,
      rdpLocalConnected: Boolean(vm.rdpHealth?.connected && vm.rdpHealth?.rdpNegotiated),
      isExternalVerified: vm.isExternalVerified,
    });
    vm.lifecycleState = state;
    vm.lifecycleLabel = getLifecycleDisplayInfo(state).label;
  }

  private saveState(): void {
    try {
      for (const vm of this.vms.values()) {
        if (!vm.lifecycleState) {
          this.syncVmLifecycle(vm);
        }
      }
      const array = Array.from(this.vms.values()).map((vm) =>
        vm.isApiManaged || vm.isPolicyManaged
          ? { ...vm, password: '[VAULT_PROTECTED]' }
          : vm
      );
      fs.writeFileSync(this.stateFilePath, JSON.stringify(array, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      serverLogger.error('VMManager', `Failed to save state: ${err}`);
    }
  }

  public async initialize(): Promise<void> {
    serverLogger.info('Server', 'Boot 1/4: Initializing Moon Studio Cloud VPS backend & hypervisor services...');

    // Start real-time host CPU sampler (2s /proc/stat delta tracking)
    hostResourceManager.startCpuSampler();

    // Boot 2/4: HostInspector checks CPU, RAM, disk, persistent storage, and QEMU TCG capability
    const hostReport = probeHostInfrastructure({ skipNetworkLookup: true });
    void refreshPublicIpv4Async();

    // Boot 3/4: Background startup task automatically checks/downloads/verifies/extracts Win10 ISO (non-blocking),
    // with automatic retry on failure; once READY, pre-installs windows-10-base.qcow2 when host budget allows.
    win10DeployManager.onReady((deployState) => {
      void this.handleWin10InstallerReady(deployState);
    });
    win10DeployManager
      .startBackgroundPreparation({ hostReport })
      .then((deployState) => this.handleWin10InstallerReady(deployState))
      .catch((err) => {
        serverLogger.error('Win10DeployBoot', `Startup background preparation error: ${err}`);
      });

    let vm = this.vms.get(this.primaryVmId);
    if (!vm) {
      serverLogger.info('VMManager', `No existing primary VM found. Provisioning default Debian 12 VM...`);
      vm = await this.createVm({
        id: this.primaryVmId,
        name: 'Moon Studio Cloud Linux (Debian 12)',
        osId: 'debian-12',
        cores: 2,
        memoryMb: 2048,
        diskGb: 40,
        username: 'Administrator',
      });
    } else {
      serverLogger.info('VMManager', `Loaded existing VM: ${vm.id} (${vm.osId} - ${vm.status})`);
      if (vm.osId === 'debian-12') {
        const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
        const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
        const rdpOk = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          skipPasswordReset: vm.isApiManaged && isProtected,
        });
        if (rdpOk) {
          vm.status = 'Ready';
          delete vm.failureReason;
          vm.statusMessage = 'Máy chủ Debian 12 Cloud VPS đang hoạt động bình thường trên hạ tầng Google Cloud.';
          this.saveState();
        } else {
          vm.status = 'Failed';
          vm.isExternalVerified = false;
          vm.failureReason = 'Debian 12 xrdp service failed X.224 check on port 3389 during startup.';
          vm.statusMessage = `Khởi tạo dịch vụ RDP thất bại: ${vm.failureReason}`;
          this.saveState();
        }
      }
      await tunnelManager.start();

      // Resume secondary Ready VMs and Windows VMs interrupted by server restart cleanly
      for (const item of this.vms.values()) {
        if (item.id !== this.primaryVmId && (item.status === 'Ready' || this.autoResumeVmIds.has(item.id))) {
          this.autoResumeVmIds.delete(item.id);
          this.startVm(item.id).catch((err) => {
            serverLogger.warn('VMManager', `Could not resume VM ${item.id}: ${err}`, item.id);
          });
        }
      }
    }

    this.startBackgroundMonitoring();
  }

  private async handleWin10InstallerReady(deployState: {
    ready: boolean;
    status: string;
    isoPath: string;
    wimIndex?: number;
  }): Promise<void> {
    if (!deployState.ready || deployState.status !== 'READY') return;
    if (this.win10ReadyHandled) return;
    if (this.win10ReadyInFlight) return this.win10ReadyInFlight;

    this.win10ReadyInFlight = (async () => {
      try {
        this.win10ReadyHandled = true;
        const snap = this.getResourceSnapshot();
        const ramEligible = snap.ram.availableForVmMb >= 4096 + 384;
        const baseState = await win10BasePreinstaller.runStartupPreinstallIfEligible({
          isoPath: deployState.isoPath,
          wimIndex: deployState.wimIndex,
          ramAllowed: ramEligible,
          cpuThrottled: snap.cpu.throttled,
        });
        if (baseState.ready && process.env.DISABLE_AUTO_WIN10_VM !== 'true') {
          const hasAnyWin10Vm = Array.from(this.vms.values()).some((v) => v.osId === 'windows-10');
          if (!hasAnyWin10Vm) {
            const preflight = this.checkProvisioningPreflight('windows-10', 4096, 2);
            if (preflight.ready) {
              serverLogger.info(
                'VMManager',
                'Windows 10 pre-installed base disk READY — auto-provisioning default Windows 10 VM alongside Debian 12...'
              );
              this.createVm({
                id: 'vm-moon-win10-default',
                name: 'Windows 10 IoT Enterprise LTSC 2021',
                osId: 'windows-10',
                cores: 2,
                memoryMb: 4096,
                diskGb: 64,
                username: 'Administrator',
              }).catch((err) => {
                serverLogger.warn('VMManager', `Auto-provision default Win10 VM skipped: ${err}`);
              });
            }
          }
        }
      } catch (err) {
        this.win10ReadyHandled = false;
        serverLogger.error('Win10DeployBoot', `Post-ready base preinstall hook error: ${err}`);
      } finally {
        this.win10ReadyInFlight = null;
      }
    })();
    return this.win10ReadyInFlight;
  }

  public getActiveResourceUsages(): ActiveVmResourceUsage[] {
    const usages: ActiveVmResourceUsage[] = Array.from(this.vms.values()).map((vm) => {
      const proc = hypervisor.getVmProcess(vm.id);
      return {
        vmId: vm.id,
        osId: vm.osId,
        memoryMb: vm.memoryMb,
        cores: vm.cores,
        status: vm.status,
        pid: proc?.pid || null,
      };
    });
    const baseBuildMemMb = win10BasePreinstaller.getActiveMemoryMb();
    if (baseBuildMemMb > 0) {
      usages.push({
        vmId: '_win10-base-preinstaller',
        osId: 'windows-10',
        memoryMb: baseBuildMemMb,
        cores: 2,
        status: 'Installing',
        pid: null,
      });
    }
    return usages;
  }

  public getResourceSnapshot(): HostResourceSnapshot {
    return hostResourceManager.getSnapshot(this.getActiveResourceUsages());
  }

  public checkProvisioningPreflight(
    osId: SupportedOsId,
    requestedMemoryMb?: number,
    requestedCores?: number
  ): {
    ready: boolean;
    code?: string;
    source?: 'native' | 'cached' | 'dockur-auto';
    dockurVersion?: string;
    error?: string;
    remediation?: string;
    allocatedMemoryMb?: number;
    kvmAvailable: boolean;
    dockerAvailable: boolean;
    win10DeployState?: Win10DeployState;
  } {
    const hasKvm = fs.existsSync('/dev/kvm');
    const dockerInfo = dockurEngine.getRuntimeInfo();
    const def = imageManager.getOsDefinition(osId);
    const activeVms = this.getActiveResourceUsages();
    const effRamMb = requestedMemoryMb || def?.recommendedRamMb || (osId === 'windows-10' ? 4096 : 2048);
    const effCores = requestedCores || def?.recommendedCores || 2;

    // 1. CPU < 95% real usage check (always reserve >= 5% for host OS & services)
    const cpuCheck = hostResourceManager.checkCpuAdmission({
      activeVms,
      requestedCores: effCores,
    });
    if (!cpuCheck.allowed) {
      return {
        ready: false,
        code: cpuCheck.code,
        error: cpuCheck.reason,
        remediation: `Chờ mức sử dụng CPU thực tế của máy chủ giảm xuống dưới ${cpuCheck.maxCpuUsagePercent}% rồi thử lại.`,
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    // 2. RAM <= 90% host ceiling check (always reserve >= 10% for host OS & services)
    const isWindows = osId === 'windows-10' || osId === 'windows-7';
    const ramCheck = hostResourceManager.checkRamAdmission({
      activeVms,
      requestedRamMb: effRamMb,
      hypervisorOverheadMb: isWindows ? 384 : 0,
    });
    if (!ramCheck.allowed) {
      return {
        ready: false,
        code: ramCheck.code,
        error: ramCheck.reason,
        remediation: `Tắt bớt máy ảo khác hoặc giảm dung lượng RAM xuống tối đa ${ramCheck.availableForVmMb} MB (luôn chừa >= 10% RAM cho máy chủ).`,
        allocatedMemoryMb: ramCheck.availableForVmMb,
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    if (osId === 'debian-12') {
      return {
        ready: true,
        source: 'native',
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    const preinstalled = Boolean(imageManager.resolvePreinstalledDiskPath(osId));

    // 3. CRITICAL Phase A -> Phase B Gate for Windows 10 IoT Enterprise LTSC 2021
    if (osId === 'windows-10' && !preinstalled) {
      const deployState = win10DeployManager.getState();
      if (!win10DeployManager.isReady()) {
        return {
          ready: false,
          code: 'WIN10_INSTALLER_NOT_READY',
          error:
            deployState.status === 'FAILED'
              ? `Quá trình chuẩn bị bộ cài Windows 10 IoT Enterprise LTSC 2021 khi khởi động server bị lỗi: ${deployState.error || 'Unknown error'}`
              : `Bộ cài Windows 10 IoT Enterprise LTSC 2021 đang được chuẩn bị nền khi khởi động server (${deployState.status} — ${deployState.progressPercent}%). Chỉ có thể tạo máy sau khi đạt trạng thái "READY".`,
          remediation:
            deployState.status === 'FAILED'
              ? deployState.remediation || 'Khởi động lại server để hệ thống tự kiểm tra và chuẩn bị lại bộ cài Windows 10.'
              : 'Vui lòng chờ tiến trình chuẩn bị nền khi khởi động server hoàn tất (có thể dùng Debian 12 ngay trong lúc chờ).',
          kvmAvailable: hasKvm,
          dockerAvailable: dockerInfo.dockerDaemonRunning,
          win10DeployState: deployState,
        };
      }
    }

    const imgStatus = imageManager.getImageStatus(osId);
    const overlay = isMemoryBackedOverlayfs();
    const hostTotalMb = Math.floor(os.totalmem() / (1024 * 1024));
    const hostAvailableMb = Math.floor(getContainerMemAvailableBytes() / (1024 * 1024));
    let otherActiveQemuMb = 0;
    for (const other of this.vms.values()) {
      if (other.osId !== 'debian-12') {
        const proc = hypervisor.getVmProcess(other.id);
        if (proc && proc.pid) {
          otherActiveQemuMb += other.memoryMb;
        }
      }
    }

    const budget = calculateSafeVmMemoryBudget({
      osId,
      requestedMemoryMb: effRamMb,
      hostTotalMb,
      hostAvailableMb,
      isMemoryBackedOverlay: overlay,
      existingDiskMb: 0,
      attachInstallerIso: !preinstalled,
      otherActiveQemuMb,
      hostReserveMb: Number(process.env.HOST_RESERVE_RAM_MB || '0') || undefined,
      win7MaxRamMb: Number(process.env.WIN7_MAX_RAM_MB || '0') || undefined,
      win10MaxRamMb: Number(process.env.WIN10_MAX_RAM_MB || '0') || undefined,
    });

    if (!budget.allowed) {
      return {
        ready: false,
        code: budget.code || 'INSUFFICIENT_HOST_MEMORY',
        error: budget.reason || `RAM khả dụng trên container không đủ để chạy thêm ${def?.name || osId}.`,
        remediation: budget.remediation || 'Hãy tắt hoặc xóa bớt máy ảo Windows đang chạy trước khi bật thêm máy mới.',
        allocatedMemoryMb: budget.allocatedMemoryMb,
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    if (osId === 'windows-10') {
      return {
        ready: true,
        source: 'cached',
        dockurVersion: '10',
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
        win10DeployState: win10DeployManager.getState(),
      };
    }

    if (imgStatus.status === 'READY') {
      return {
        ready: true,
        source: 'cached',
        dockurVersion: imgStatus.dockurVersion,
        kvmAvailable: hasKvm,
        dockerAvailable: dockerInfo.dockerDaemonRunning,
      };
    }

    // With NBD HTTP Range streaming on Cloud Run RAM-backed overlayfs, multi-GB ISO never fills RAM/overlay
    if (!shouldStreamIsoViaNbd()) {
      const isoDir = path.join(resolvePersistentStorageRoot().dataDir, 'iso');
      const availBytes = getAvailableDiskBytes(isoDir);
      const orderedMirrors = getOrderedMirrorsForOs(osId, availBytes);
      const smallestMirror = [...orderedMirrors].sort((a, b) => a.expectedSizeBytes - b.expectedSizeBytes)[0];
      if (availBytes > 0 && smallestMirror && availBytes < smallestMirror.expectedSizeBytes + 256 * 1024 * 1024) {
        const availGib = (availBytes / (1024 * 1024 * 1024)).toFixed(2);
        const needGib = ((smallestMirror.expectedSizeBytes + 256 * 1024 * 1024) / (1024 * 1024 * 1024)).toFixed(2);
        return {
          ready: false,
          code: 'INSUFFICIENT_DISK_SPACE',
          error: `Không đủ dung lượng ổ đĩa để tự động tải ${def?.name || osId} ISO (cần ${needGib} GiB, còn trống ${availGib} GiB).`,
          remediation: 'Xóa bớt file tạm/ISO cũ hoặc tăng dung lượng ổ đĩa lưu trữ.',
          kvmAvailable: hasKvm,
          dockerAvailable: dockerInfo.dockerDaemonRunning,
        };
      }
    }

    return {
      ready: true,
      source: 'dockur-auto',
      dockurVersion: imgStatus.dockurVersion,
      kvmAvailable: hasKvm,
      dockerAvailable: dockerInfo.dockerDaemonRunning,
    };
  }

  public async createVm(options: {
    id?: string;
    name?: string;
    osId: SupportedOsId;
    cores?: number;
    memoryMb?: number;
    diskGb?: number;
    networkModel?: 'e1000e' | 'virtio';
    username?: string;
    useDefaultCredentialPolicy?: boolean;
    generateUniqueCredentials?: boolean;
    onProvisioned?: (vm: VmRecord, actualPassword: string) => void;
    onProvisionFailed?: (vm: VmRecord, reason: string) => void;
  }): Promise<VmRecord> {
    const osDef = imageManager.getOsDefinition(options.osId);
    if (!osDef) {
      throw new Error(`Unsupported OS: '${options.osId}'. Supported options are 'debian-12', 'windows-10', and 'windows-7'.`);
    }

    const vmId = options.id || `vm-${options.osId}-${Date.now().toString(36)}`;
    const name = options.name || `Cloud VPS (${osDef.name})`;
    const cores = options.cores || osDef.recommendedCores;
    const memoryMb = options.memoryMb || osDef.recommendedRamMb;
    const diskGb = options.diskGb || osDef.minDiskGb;
    const networkModel: 'e1000e' | 'virtio' =
      options.osId === 'windows-10' && options.networkModel === 'virtio' ? 'virtio' : 'e1000e';

    // Enforce Phase A Gate & Host RAM (<=90%) / CPU (<95%) Admission Control for user-requested VMs
    const isBootstrapPrimary = options.id === this.primaryVmId && options.osId === 'debian-12';
    if (!isBootstrapPrimary) {
      const preflight = this.checkProvisioningPreflight(options.osId, memoryMb, cores);
      if (!preflight.ready) {
        throw new ProvisioningGateError(
          preflight.code || 'PREFLIGHT_FAILED',
          preflight.error || `Không đủ điều kiện khởi tạo máy ảo ${osDef.name}.`,
          preflight.remediation
        );
      }
    }

    const isApiManaged = Boolean(options.generateUniqueCredentials);
    const isPolicyManaged = Boolean(options.useDefaultCredentialPolicy) && !isApiManaged;
    const defaultUsername = (isApiManaged && options.osId === 'debian-12')
      ? `moon_${vmId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}`
      : osDef.defaultUsername;
    const username = options.username || defaultUsername;

    const actualPassword = isPolicyManaged
      ? getDefaultProvisioningPassword()
      : generateWindowsPassword(16);

    serverLogger.registerSecret(actualPassword);

    if (isApiManaged) {
      this.runtimePasswords.set(vmId, actualPassword);
    }
    if (options.onProvisioned || options.onProvisionFailed) {
      this.provisioningCallbacks.set(vmId, {
        onProvisioned: options.onProvisioned,
        onProvisionFailed: options.onProvisionFailed,
      });
    }

    const storedRecordPassword = (isApiManaged || isPolicyManaged) ? '[VAULT_PROTECTED]' : actualPassword;

    // Dynamic port allocation: Debian 12 primary uses 3389; Windows and secondary VMs allocate a distinct local port
    const localPort = (options.id === this.primaryVmId && options.osId === 'debian-12')
      ? 3389
      : networkManager.allocatePort(vmId);

    const hasKvm = fs.existsSync('/dev/kvm');
    const hypervisorId = options.osId === 'debian-12'
      ? 'container-native-linux'
      : hasKvm
      ? 'qemu-kvm-x86_64'
      : 'qemu-tcg-x86_64';

    const networkInterfaceType =
      options.osId === 'windows-10'
        ? networkModel === 'virtio'
          ? 'VirtIO'
          : 'Intel e1000e'
        : options.osId === 'windows-7'
        ? 'Intel e1000'
        : 'VirtIO-net';

    serverLogger.info(
      'VMManager',
      `Queued creation for new VM: ${name} [${options.osId}] (RAM: ${memoryMb}MB, Cores: ${cores}, Disk: ${diskGb}GB, NIC: ${networkInterfaceType}, LocalPort: ${localPort})`,
      vmId
    );

    const realIp = '159.223.110.159';
    const now = new Date().toISOString();
    const record: VmRecord = {
      id: vmId,
      name,
      osId: options.osId,
      osName: osDef.name,
      version: osDef.version,
      imageId: osDef.isoFileName,
      cores,
      memoryMb,
      diskGb,
      username,
      password: storedRecordPassword,
      localPort,
      ipAddress: realIp,
      publicEndpoint: 'Pending',
      hypervisorId,
      networkModel: options.osId === 'windows-10' ? networkModel : undefined,
      networkConfig: {
        interfaceType: networkInterfaceType,
        localPort,
        guestPort: 3389,
        natForwarding: true,
      },
      status: 'Queued',
      detailedStatus: options.osId === 'windows-10' ? 'Installing Windows' : undefined,
      lifecycleState: 'PENDING',
      lifecycleLabel: 'PENDING',
      statusMessage: 'Yêu cầu tạo máy ảo đã vào hàng đợi xử lý.',
      securityWarning: osDef.securityWarning,
      createdAt: now,
      updatedAt: now,
      isExternalVerified: false,
      isPolicyManaged,
      isApiManaged,
      credentialsConfigured: false,
      installCompleted: false,
    };

    this.vms.set(vmId, record);
    this.saveState();

    // Execute multi-stage provisioning asynchronously
    this.executeProvisioningPipeline(vmId).catch((err) => {
      serverLogger.error('Provisioner', `Pipeline failed for VM ${vmId}: ${err}`, vmId);
    });

    return record;
  }

  /**
   * Generates Autounattend.xml and builds an ISO with genisoimage (when available)
   * ensuring the initial Windows management account has full local Administrators privileges
   * while keeping Windows UAC intact (never disables EnableLUA).
   */
  private prepareWindowsGuestCredentialsPayload(
    vm: VmRecord,
    password: string,
    installerIsoPath?: string,
    overrideWimIndex?: number
  ): string | undefined {
    const check = validateWindowsPassword(password);
    if (!check.valid) {
      throw new Error(`Generated ${vm.osName} password failed complexity policy: ${check.reason}`);
    }

    const provDir = path.join(resolvePersistentStorageRoot().dataDir, 'provisioning', vm.id);
    fs.mkdirSync(provDir, { recursive: true, mode: 0o700 });

    const wimIndex =
      overrideWimIndex ||
      (installerIsoPath && fs.existsSync(installerIsoPath)
        ? resolvePreferredWimImageIndex(installerIsoPath, vm.osId as 'windows-7' | 'windows-10')
        : vm.osId === 'windows-7'
        ? 4
        : 1);

    const autounattendXml = buildWindowsAutounattendXml({
      osId: vm.osId === 'windows-10' ? 'windows-10' : 'windows-7',
      username: vm.username || 'Administrator',
      password,
      computerName: vm.id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 15) || 'MOONVPS',
      wimIndex,
    });

    const xmlPath = path.join(provDir, 'Autounattend.xml');
    fs.writeFileSync(xmlPath, autounattendXml, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const unattendIsoPath = path.join(provDir, 'Autounattend.iso');
    const genisoBin = fs.existsSync('/usr/bin/genisoimage')
      ? '/usr/bin/genisoimage'
      : fs.existsSync('/usr/bin/mkisofs')
      ? '/usr/bin/mkisofs'
      : null;

    if (genisoBin) {
      try {
        execFileSync(genisoBin, ['-J', '-R', '-V', 'UNATTEND', '-o', unattendIsoPath, xmlPath], {
          stdio: 'pipe',
          timeout: 15000,
        });
        serverLogger.info(
          'Provisioner',
          `Prepared ${vm.osName} Unattended Autounattend.iso (user=${vm.username}, WIM index=${wimIndex}, hibernate/pagefile/SuperFetch optimized, UAC preserved)`,
          vm.id
        );
        return unattendIsoPath;
      } catch (err) {
        serverLogger.warn('Provisioner', `genisoimage warning while building Autounattend.iso: ${err}`, vm.id);
      }
    }

    serverLogger.info('Provisioner', `Prepared ${vm.osName} Autounattend.xml package for ${vm.id}`, vm.id);
    return undefined;
  }

  private prepareWindowsDiskProvisionPayload(vm: VmRecord, password: string): string | undefined {
    const check = validateWindowsPassword(password);
    if (!check.valid) return undefined;
    const provDir = path.join(resolvePersistentStorageRoot().dataDir, 'provisioning', vm.id);
    fs.mkdirSync(provDir, { recursive: true, mode: 0o700 });
    const cmdPath = path.join(provDir, 'sync-cred.cmd');
    const provisionIsoPath = path.join(provDir, 'PROVISION.iso');
    fs.writeFileSync(cmdPath, buildCredentialSyncScript(vm.username || 'Administrator', password), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const genisoBin = fs.existsSync('/usr/bin/genisoimage')
      ? '/usr/bin/genisoimage'
      : fs.existsSync('/usr/bin/mkisofs')
      ? '/usr/bin/mkisofs'
      : null;
    if (!genisoBin) return undefined;
    try {
      execFileSync(genisoBin, ['-J', '-R', '-V', 'MOONPROV', '-o', provisionIsoPath, cmdPath], {
        stdio: 'pipe',
        timeout: 15000,
      });
      return provisionIsoPath;
    } catch (err) {
      serverLogger.warn('Provisioner', `Could not build PROVISION.iso for ${vm.id}: ${err}`, vm.id);
      return undefined;
    }
  }

  private hasInstalledWindowsDisk(vmId: string): string | null {
    const vmDisk = path.join(resolvePersistentStorageRoot().dataDir, 'disks', `${vmId}.qcow2`);
    const check = imageManager.validateInstalledDiskImage(vmDisk);
    if (check.valid) return vmDisk;
    if (hypervisor.inspectDiskHasBootableWindowsPartition(vmDisk)) {
      return vmDisk;
    }
    return null;
  }

  private async resolveWindowsBootMedia(
    vm: VmRecord,
    onProgress?: (pct: number, stageMsg: string) => void
  ): Promise<{
    baseDiskPath?: string;
    isoPath?: string;
    isoNbdSource?: NbdSource;
    wimIndex: number;
  }> {
    const winOsId = vm.osId === 'windows-10' ? 'windows-10' : 'windows-7';
    const baseDisk = imageManager.resolvePreinstalledDiskPath(vm.osId);
    if (baseDisk && imageManager.validateInstalledDiskImage(baseDisk).valid) {
      onProgress?.(100, `${vm.osName} Disk Image Verified`);
      return { baseDiskPath: baseDisk, wimIndex: winOsId === 'windows-7' ? 4 : 1 };
    }

    // Phase B for Windows 10 IoT Enterprise LTSC 2021 MUST strictly use the already-prepared Phase A installer
    // (never re-download, never re-extract, never restart Phase A).
    if (winOsId === 'windows-10') {
      const prepared = win10DeployManager.getPreparedArtifact();
      if (!prepared || !fs.existsSync(prepared.isoPath)) {
        const deployState = win10DeployManager.getState();
        throw new ProvisioningGateError(
          'WIN10_INSTALLER_NOT_READY',
          `Không thể khởi tạo Windows 10 VM: bộ cài Phase A đang ở trạng thái "${deployState.status}" (${deployState.error || `${deployState.progressPercent}%`}).`
        );
      }
      onProgress?.(100, `Sử dụng bộ cài Phase A đã chuẩn bị sẵn (${prepared.edition}, SHA-256 verified)`);
      serverLogger.info(
        'Provisioner',
        `Phase B using prepared Phase A Windows 10 installer (${prepared.isoPath}, WIM index=${prepared.wimIndex}) without re-downloading or re-extracting.`,
        vm.id
      );
      return {
        isoPath: prepared.isoPath,
        wimIndex: prepared.wimIndex || resolvePreferredWimImageIndex(prepared.isoPath, 'windows-10'),
      };
    }

    const localIsoPath = imageManager.resolveIsoPath(vm.osId);
    let detectedWimIndex = 4;
    if (fs.existsSync(localIsoPath) && imageManager.validateWindowsIsoMedia(localIsoPath).valid) {
      detectedWimIndex = resolvePreferredWimImageIndex(localIsoPath, winOsId);
    }

    if (shouldStreamIsoViaNbd()) {
      const nbdResolved = await imageManager.resolveNbdIsoSource(winOsId);
      if (nbdResolved) {
        if (fs.existsSync(localIsoPath)) {
          try {
            const sizeBytes = fs.statSync(localIsoPath).size;
            fs.unlinkSync(localIsoPath);
            imageManager.refreshImageStatuses();
            serverLogger.info(
              'Provisioner',
              `Reclaimed ${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB container RAM by streaming ${vm.osName} ISO directly via HTTP-Range NBD (${nbdResolved.provider}).`,
              vm.id
            );
          } catch {
            // ignore
          }
        }
        onProgress?.(100, `Sẵn sàng stream ${nbdResolved.edition} qua NBD (~64 MiB RAM cache)`);
        return {
          isoNbdSource: {
            type: 'http',
            url: nbdResolved.url,
            fallbackUrls: nbdResolved.fallbackUrls,
            totalSizeBytes: nbdResolved.totalSizeBytes,
            exportName: 'iso',
          },
          wimIndex: detectedWimIndex,
        };
      }
    }

    const mediaPath = await imageManager.ensureImageReady(vm.osId, onProgress);
    if (mediaPath.endsWith('.qcow2')) {
      return { baseDiskPath: mediaPath, wimIndex: detectedWimIndex };
    }
    return {
      isoPath: mediaPath,
      wimIndex: resolvePreferredWimImageIndex(mediaPath, winOsId),
    };
  }

  private reclaimUnusedIsoMemory(osId: SupportedOsId): void {
    // Preserve shared Phase A Windows 10 ISO so subsequent Phase B VMs never re-download
    if (osId === 'windows-10' && win10DeployManager.isReady()) return;
    if (osId !== 'windows-7') return;
    if (!isMemoryBackedOverlayfs()) return;

    const busyUsingIso = Array.from(this.vms.values()).some(
      (other) =>
        other.osId === osId &&
        !other.installCompleted &&
        (other.status === 'Queued' ||
          other.status === 'Preparing' ||
          other.status === 'Downloading Image' ||
          other.status === 'Creating Disk' ||
          other.status === 'Installing' ||
          other.status === 'Booting')
    );
    if (busyUsingIso) return;

    const isoPath = imageManager.resolveIsoPath(osId);
    if (!fs.existsSync(isoPath)) return;
    try {
      const sizeBytes = fs.statSync(isoPath).size;
      fs.unlinkSync(isoPath);
      imageManager.refreshImageStatuses();
      serverLogger.info(
        'VMManager',
        `Reclaimed ${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB container RAM by removing cached ${osId} installer ISO after persistent QCOW2 installation finished.`
      );
    } catch {
      // ignore
    }
  }

  private async executeProvisioningPipeline(vmId: string): Promise<void> {
    const vm = this.vms.get(vmId);
    if (!vm) return;

    const callbacks = this.provisioningCallbacks.get(vmId);
    const effectivePwd =
      this.runtimePasswords.get(vmId) ||
      (vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password);
    const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';

    try {
      // 1. Preparing
      if (!this.vms.has(vmId)) return;
      vm.status = 'Preparing';
      delete vm.oomDetected;
      delete vm.remediation;
      this.syncVmLifecycle(vm, 'PREPARING');
      vm.statusMessage = 'Đang kiểm tra tài nguyên và chuẩn bị môi trường máy chủ...';
      vm.updatedAt = new Date().toISOString();
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 1/5] Preparing environment for ${vm.name}...`, vmId);
      await new Promise((r) => setTimeout(r, 300));

      // 2. Resolve Prepared Installer Media (Windows 10 strictly uses Phase A artifact; Windows 7 auto-resolves via dockurr)
      if (!this.vms.has(vmId)) return;
      if (vm.osId === 'windows-10') {
        vm.status = 'Preparing';
        vm.detailedStatus = 'Installing Windows';
        this.syncVmLifecycle(vm, 'PREPARING');
        vm.statusMessage = 'Đang gắn bộ cài Windows 10 IoT Enterprise LTSC 2021 đã chuẩn bị từ Phase A...';
      } else {
        vm.status = 'Downloading Image';
        this.syncVmLifecycle(vm, 'DOWNLOADING_ISO');
        vm.statusMessage = isWindows
          ? `Đang tự động chuẩn bị nguồn ${vm.osName} ISO qua dockurr/windows...`
          : `Đang xác minh nguồn cài đặt gốc cho hệ điều hành ${vm.osName}...`;
      }
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 2/5] Resolving installation media for ${vm.osId}...`, vmId);
      let lastSavedProgressAt = 0;
      const progressCb = (_pct: number, stageMsg: string) => {
        if (!this.vms.has(vmId)) return;
        vm.status = vm.osId === 'windows-10' ? 'Preparing' : 'Downloading Image';
        this.syncVmLifecycle(vm, vm.osId === 'windows-10' ? 'PREPARING' : 'DOWNLOADING_ISO');
        vm.statusMessage = stageMsg;
        vm.updatedAt = new Date().toISOString();
        if (Date.now() - lastSavedProgressAt > 8000) {
          lastSavedProgressAt = Date.now();
          this.saveState();
        }
      };

      let resolvedMedia: {
        baseDiskPath?: string;
        isoPath?: string;
        isoNbdSource?: NbdSource;
        wimIndex: number;
      };
      if (isWindows) {
        resolvedMedia = await this.resolveWindowsBootMedia(vm, progressCb);
      } else {
        const debianPath = await imageManager.ensureImageReady(vm.osId, progressCb);
        resolvedMedia = { isoPath: debianPath, wimIndex: 1 };
      }

      if (!this.vms.has(vmId)) return;
      const isPreinstalledDisk = Boolean(isWindows && resolvedMedia.baseDiskPath);
      vm.mediaSourceType = vm.osId === 'debian-12'
        ? 'native_host'
        : isPreinstalledDisk
        ? 'installed_disk'
        : 'iso';

      // 3. Creating Virtual Disk
      if (!this.vms.has(vmId)) return;
      vm.status = 'Creating Disk';
      if (vm.osId === 'windows-10') vm.detailedStatus = 'Installing Windows';
      this.syncVmLifecycle(vm, 'PREPARING');
      vm.statusMessage = `Đang khởi tạo ổ đĩa QCOW2 bền vững dung lượng ${vm.diskGb}GB...`;
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 3/5] Allocating storage (${vm.diskGb}GB)...`, vmId);
      hypervisor.prepareDisk(vmId, vm.diskGb, resolvedMedia.baseDiskPath);

      // 4. Configuring Credentials & Booting Hypervisor
      if (!this.vms.has(vmId)) return;
      vm.status = 'Booting';
      if (vm.osId === 'windows-10') vm.detailedStatus = isPreinstalledDisk ? 'Starting Windows' : 'Installing Windows';
      this.syncVmLifecycle(vm, 'BOOTING');
      vm.statusMessage = 'Đang khởi động hệ điều hành và cấu hình tài khoản truy cập...';
      this.saveState();
      serverLogger.info('Provisioner', `[Stage 4/5] Configuring guest credentials and launching hypervisor...`, vmId);

      if (!effectivePwd || effectivePwd === '[POLICY_MANAGED]' || effectivePwd === '[VAULT_PROTECTED]') {
        throw new Error('Missing valid runtime guest password for credential provisioning.');
      }

      let autounattendIsoPath: string | undefined;
      if (vm.osId === 'debian-12') {
        const rdpReady = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          strictPasswordSync: Boolean(vm.isApiManaged),
        });
        if (!rdpReady) {
          throw new Error('Debian 12 Remote Desktop service (xrdp) failed local X.224 readiness check on port 3389.');
        }
      } else if (isWindows && !isPreinstalledDisk) {
        autounattendIsoPath = this.prepareWindowsGuestCredentialsPayload(
          vm,
          effectivePwd,
          resolvedMedia.isoPath,
          resolvedMedia.wimIndex
        );
      } else if (isWindows && isPreinstalledDisk) {
        autounattendIsoPath = this.prepareWindowsDiskProvisionPayload(vm, effectivePwd);
      }

      if (!this.vms.has(vmId)) return;

      const procInfo = await hypervisor.startVmProcess({
        vmId: vm.id,
        osId: vm.osId,
        hostPort: vm.localPort,
        memoryMb: vm.memoryMb,
        cores: vm.cores,
        diskGb: vm.diskGb,
        networkModel: vm.networkModel,
        isoPath: resolvedMedia.isoPath,
        isoNbdSource: resolvedMedia.isoNbdSource,
        baseDiskPath: resolvedMedia.baseDiskPath,
        autounattendIsoPath,
        bootFromDiskOnly: isPreinstalledDisk,
      });

      if (procInfo.status === 'ERROR' || !procInfo.pid) {
        const diag = hypervisor.getExitDiagnostics(vm.id);
        if (diag?.oomDetected) vm.oomDetected = true;
        if (diag?.remediation) vm.remediation = diag.remediation;
        throw new Error(diag?.exitReason || `Hypervisor process failed to enter RUNNING state for ${vm.osId}.`);
      }
      if (procInfo.memoryMb && procInfo.memoryMb !== vm.memoryMb) {
        vm.memoryMb = procInfo.memoryMb;
      }
      if (procInfo.hardwareProfile) {
        vm.hardwareProfile = procInfo.hardwareProfile;
      }
      vm.bootMode = procInfo.bootMode;

      // Verify QMP / QEMU liveness for Windows guests
      if (isWindows) {
        const qmpState = await hypervisor.queryStatus(vm.id);
        if (!qmpState || !qmpState.running) {
          const diag = hypervisor.getExitDiagnostics(vm.id);
          if (diag?.oomDetected) vm.oomDetected = true;
          if (diag?.remediation) vm.remediation = diag.remediation;
          throw new Error(diag?.exitReason || `QEMU hypervisor for ${vm.osName} did not report running state via QMP.`);
        }
      }

      if (vm.osId === 'debian-12') {
        const localBridgeCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: 5,
          retryDelayMs: 400,
        });
        if (!localBridgeCheck.connected || !localBridgeCheck.rdpNegotiated) {
          throw new Error(
            `Local RDP endpoint 127.0.0.1:${vm.localPort} failed X.224 handshake check: ${localBridgeCheck.statusMessage}`
          );
        }
      }

      // 5. Public Network Synchronization
      const tunnel = await tunnelManager.startTunnelForVm(vm.id, vm.localPort, {
        preferNewPort: isWindows || vm.id !== this.primaryVmId,
      });

      if (!tunnel.publicPort || !tunnel.publicHost) {
        throw new Error('Public TCP relay tunnel failed to allocate an external IP:Port endpoint.');
      }

      const assignedPort = tunnel.publicPort;
      const assignedHost = tunnel.publicHost;
      const endpoint = `${assignedHost}:${assignedPort}`;

      if (vm.osId === 'debian-12') {
        let verified = false;
        for (let attempt = 1; attempt <= 4; attempt++) {
          verified = await tunnelManager.verifyExternalEndpoint(vm.id);
          if (verified) break;
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        const verifiedStatus = tunnelManager.getStatus(vm.id);
        vm.rdpHealth = verifiedStatus.rdpVerification;
        if (!verified || !verifiedStatus.rdpVerification?.rdpNegotiated) {
          throw new Error(
            `Public RDP endpoint ${endpoint} failed end-to-end X.224 handshake verification: ${
              verifiedStatus.rdpVerification?.statusMessage || 'unverified'
            }`
          );
        }

        const completedAt = new Date().toISOString();
        vm.credentialsConfigured = true;
        vm.credentialsConfiguredAt = completedAt;
        vm.provisioningCompletedAt = completedAt;
        vm.installCompleted = true;
        vm.status = 'Ready';
        this.syncVmLifecycle(vm, 'READY');
        vm.lastBootAt = completedAt;
        vm.ipAddress = assignedHost;
        vm.publicEndpoint = endpoint;
        delete vm.failureReason;
        vm.statusMessage = 'Máy chủ đang hoạt động bình thường trên hạ tầng Google Cloud.';
        vm.isExternalVerified = true;
        vm.updatedAt = completedAt;
      } else {
        // Honest Windows RDP verification: NEVER fake Ready unless guest port 3389 answers X.224 0xD0
        vm.lifecycleState = 'CONFIGURING_RDP';
        vm.lifecycleLabel = 'CONFIGURING_RDP';
        if (vm.osId === 'windows-10') {
          vm.detailedStatus = isPreinstalledDisk ? 'Starting Windows' : 'Installing Windows';
        }
        const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: isPreinstalledDisk ? 6 : 2,
          retryDelayMs: 500,
        });
        vm.rdpHealth = rdpCheck;

        if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
          vm.lifecycleState = 'VERIFYING';
          vm.lifecycleLabel = 'VERIFYING';
          const verifiedExt = await tunnelManager.verifyExternalEndpoint(vm.id);
          const completedAt = new Date().toISOString();
          vm.installCompleted = true;
          vm.bootMode = 'disk';
          vm.credentialsConfigured = true;
          vm.credentialsConfiguredAt = completedAt;
          vm.provisioningCompletedAt = completedAt;
          vm.status = 'Ready';
          if (vm.osId === 'windows-10') vm.detailedStatus = 'Windows ready';
          this.syncVmLifecycle(vm, 'READY');
          vm.lastBootAt = completedAt;
          vm.ipAddress = assignedHost;
          vm.publicEndpoint = endpoint;
          delete vm.failureReason;
          vm.isExternalVerified = verifiedExt;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động và xác thực RDP thành công tại ${endpoint}.`;
          vm.updatedAt = completedAt;
        } else if (!isPreinstalledDisk) {
          // Booted from genuine installer ISO on QEMU; guest Windows Setup has not finished installing RDP yet.
          const hasKvm = fs.existsSync('/dev/kvm');
          vm.installCompleted = false;
          vm.bootMode = 'iso';
          vm.credentialsConfigured = false;
          vm.isExternalVerified = false;
          vm.status = 'Installing';
          if (vm.osId === 'windows-10') vm.detailedStatus = 'Installing Windows';
          this.syncVmLifecycle(vm, 'INSTALLING');
          vm.lastBootAt = new Date().toISOString();
          vm.ipAddress = assignedHost;
          vm.publicEndpoint = endpoint;
          vm.statusMessage = `${vm.osName} đang chạy trình cài đặt Windows thật trên QEMU (${hasKvm ? 'KVM' : 'TCG — không dùng /dev/kvm nên cài đặt sẽ chậm hơn'}). Dịch vụ RDP sẽ sẵn sàng sau khi quá trình cài đặt hoàn tất.`;
          vm.updatedAt = new Date().toISOString();
          this.saveState();
          serverLogger.info('Provisioner', `${vm.osName} VM ${vm.id} is actively installing from prepared ISO via QEMU (VNC/QMP alive; RDP pending completion).`, vmId);
          return;
        } else {
          throw new Error(
            `${vm.osName} disk image booted on QEMU, but guest RDP did not respond to X.224 handshake on port ${vm.localPort}: ${rdpCheck.statusMessage}`
          );
        }
      }

      if (callbacks?.onProvisioned) {
        callbacks.onProvisioned(vm, effectivePwd);
      }
      if (vm.isApiManaged) {
        this.runtimePasswords.delete(vmId);
        vm.password = '[VAULT_PROTECTED]';
      }
      this.provisioningCallbacks.delete(vmId);

      this.saveState();
      serverLogger.info('Provisioner', `[Stage 5/5] VM online with verified credentials and endpoint: ${endpoint}`, vmId);
    } catch (err: unknown) {
      if (!this.vms.has(vmId)) {
        this.runtimePasswords.delete(vmId);
        this.provisioningCallbacks.delete(vmId);
        serverLogger.info('Provisioner', `Provisioning cancelled cleanly because VM ${vmId} was deleted.`, vmId);
        return;
      }
      const baseMsg = err instanceof Error ? err.message : String(err);
      const diag = hypervisor.getExitDiagnostics(vmId);
      const fullReason = baseMsg;

      vm.status = 'Failed';
      if (vm.osId === 'windows-10') vm.detailedStatus = 'Installation failed';
      this.syncVmLifecycle(vm, 'ERROR');
      if (diag?.oomDetected) vm.oomDetected = true;
      if (diag?.remediation && !vm.remediation) vm.remediation = diag.remediation;
      vm.credentialsConfigured = false;
      vm.isExternalVerified = false;
      vm.failureReason = fullReason;
      vm.statusMessage = `Khởi tạo thất bại: ${fullReason}`;
      vm.updatedAt = new Date().toISOString();
      this.runtimePasswords.delete(vmId);
      if (vm.isApiManaged) {
        vm.password = '[VAULT_PROTECTED]';
      }
      if (callbacks?.onProvisionFailed) {
        callbacks.onProvisionFailed(vm, fullReason);
      }
      this.provisioningCallbacks.delete(vmId);
      this.saveState();
      serverLogger.error('Provisioner', `Provisioning failed: ${fullReason}`, vmId);
    }
  }

  public async syncTunnelEndpoint(vmId: string): Promise<void> {
    const vm = this.vms.get(vmId);
    if (!vm) return;

    const tunnel = tunnelManager.getStatus(vmId);
    if (tunnel.publicPort && tunnel.isVerified) {
      vm.ipAddress = tunnel.publicHost;
      vm.publicEndpoint = tunnel.publicEndpoint;
      vm.status = 'Ready';
      delete vm.failureReason;
      vm.statusMessage =
        vm.osId === 'windows-10'
          ? `Máy ảo Windows 10 đã sẵn sàng qua cổng kết nối ${tunnel.publicEndpoint}.`
          : vm.osId === 'windows-7'
          ? `Máy ảo Windows 7 SP1 đã sẵn sàng qua cổng kết nối ${tunnel.publicEndpoint}.`
          : 'Máy ảo đã sẵn sàng và cổng kết nối từ xa đã được xác thực.';
      vm.isExternalVerified = true;
      vm.updatedAt = new Date().toISOString();
      this.saveState();
    } else if (tunnel.publicPort && (vm.osId === 'debian-12' || vm.installCompleted)) {
      const verified = await tunnelManager.verifyExternalEndpoint(vmId);
      if (verified) {
        vm.ipAddress = tunnel.publicHost;
        vm.publicEndpoint = tunnel.publicEndpoint;
        vm.status = 'Ready';
        delete vm.failureReason;
        vm.isExternalVerified = true;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
      }
    }
  }

  public async startVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) {
      serverLogger.warn('VMManager', `Operation locked: VM ${vmId} is currently undergoing another action.`, vmId);
      return false;
    }
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
      const activeVms = this.getActiveResourceUsages();

      // Enforce 90% RAM limit & 95% real CPU limit before booting VM
      const cpuCheck = hostResourceManager.checkCpuAdmission({
        activeVms,
        requestedCores: vm.cores,
        excludeVmId: vm.id,
      });
      if (!cpuCheck.allowed) {
        vm.failureReason = cpuCheck.reason;
        vm.statusMessage = cpuCheck.reason;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
        serverLogger.warn('VMManager', `Blocked startVm ${vmId}: ${cpuCheck.reason}`, vmId);
        return false;
      }

      const ramCheck = hostResourceManager.checkRamAdmission({
        activeVms,
        requestedRamMb: vm.memoryMb,
        excludeVmId: vm.id,
        hypervisorOverheadMb: isWindows ? 384 : 0,
      });
      if (!ramCheck.allowed) {
        vm.failureReason = ramCheck.reason;
        vm.statusMessage = ramCheck.reason;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
        serverLogger.warn('VMManager', `Blocked startVm ${vmId}: ${ramCheck.reason}`, vmId);
        return false;
      }

      serverLogger.info('VMManager', `Starting VM ${vmId} (${vm.osId})...`, vmId);
      vm.status = 'Booting';
      if (vm.osId === 'windows-10') {
        vm.detailedStatus = vm.installCompleted ? 'Starting Windows' : 'Installing Windows';
      }
      delete vm.oomDetected;
      delete vm.remediation;
      this.syncVmLifecycle(vm, 'BOOTING');
      vm.statusMessage = `Đang khởi động máy ảo ${vm.osName}...`;
      vm.updatedAt = new Date().toISOString();
      this.saveState();

      if (vm.osId === 'debian-12') {
        const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
        const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
        const rdpOk = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          skipPasswordReset: vm.isApiManaged && isProtected,
        });
        if (!rdpOk) {
          throw new Error('Debian 12 xrdp failed X.224 readiness check.');
        }

        await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
          diskGb: vm.diskGb,
        });
      } else {
        const installedDisk = this.hasInstalledWindowsDisk(vm.id);
        const bootFromDiskOnly = Boolean(vm.installCompleted || installedDisk);
        let isoPath: string | undefined;
        let isoNbdSource: NbdSource | undefined;
        let baseDiskPath: string | undefined;
        let wimIndex: number | undefined;

        if (bootFromDiskOnly) {
          baseDiskPath = installedDisk || undefined;
        } else {
          const media = await this.resolveWindowsBootMedia(vm);
          baseDiskPath = media.baseDiskPath;
          isoPath = media.isoPath;
          isoNbdSource = media.isoNbdSource;
          wimIndex = media.wimIndex;
        }

        const provDir = path.join(resolvePersistentStorageRoot().dataDir, 'provisioning', vm.id);
        const provIso = path.join(provDir, 'Autounattend.iso');
        const diskProvIso = path.join(provDir, 'PROVISION.iso');
        let autounattendIsoPath: string | undefined =
          bootFromDiskOnly && fs.existsSync(diskProvIso)
            ? diskProvIso
            : !bootFromDiskOnly && fs.existsSync(provIso)
            ? provIso
            : undefined;
        if (!bootFromDiskOnly) {
          const effectivePwd =
            this.runtimePasswords.get(vm.id) ||
            (vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password);
          if (effectivePwd && effectivePwd !== '[POLICY_MANAGED]' && effectivePwd !== '[VAULT_PROTECTED]') {
            autounattendIsoPath = this.prepareWindowsGuestCredentialsPayload(vm, effectivePwd, isoPath, wimIndex);
          }
        }
        const procInfo = await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
          diskGb: vm.diskGb,
          networkModel: vm.networkModel,
          isoPath,
          isoNbdSource,
          baseDiskPath,
          autounattendIsoPath,
          bootFromDiskOnly,
        });
        if (procInfo.memoryMb && procInfo.memoryMb !== vm.memoryMb) {
          vm.memoryMb = procInfo.memoryMb;
        }
        if (procInfo.hardwareProfile) {
          vm.hardwareProfile = procInfo.hardwareProfile;
        }
        vm.bootMode = procInfo.bootMode;
      }

      const tunnel = await tunnelManager.startTunnelForVm(vm.id, vm.localPort, {
        preferNewPort: isWindows || vm.id !== this.primaryVmId,
      });

      if (tunnel.publicPort && tunnel.publicHost) {
        vm.ipAddress = tunnel.publicHost;
        vm.publicEndpoint = `${tunnel.publicHost}:${tunnel.publicPort}`;
      }

      if (vm.osId === 'debian-12') {
        vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
        vm.status = 'Ready';
        this.syncVmLifecycle(vm, 'READY');
        delete vm.failureReason;
        vm.lastBootAt = new Date().toISOString();
        vm.statusMessage = 'Máy ảo đang hoạt động bình thường.';
      } else {
        const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: vm.installCompleted ? 6 : 2,
          retryDelayMs: 500,
        });
        vm.rdpHealth = rdpCheck;
        if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
          vm.installCompleted = true;
          vm.bootMode = 'disk';
          vm.status = 'Ready';
          if (vm.osId === 'windows-10') vm.detailedStatus = 'Windows ready';
          this.syncVmLifecycle(vm, 'READY');
          delete vm.failureReason;
          vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động và sẵn sàng RDP.`;
        } else {
          vm.status = 'Installing';
          if (vm.osId === 'windows-10') {
            vm.detailedStatus = vm.installCompleted ? 'Starting Windows' : 'Installing Windows';
          }
          this.syncVmLifecycle(vm, vm.installCompleted ? 'BOOTING' : 'INSTALLING');
          vm.isExternalVerified = false;
          vm.statusMessage = `${vm.osName} đang chạy trên QEMU; đang chờ hệ điều hành hoàn tất boot/cài đặt và mở dịch vụ RDP.`;
        }
        vm.lastBootAt = new Date().toISOString();
      }

      this.saveState();
      return true;
    } catch (err: unknown) {
      const vm = this.vms.get(vmId);
      if (vm) {
        const reason = err instanceof Error ? err.message : String(err);
        const diag = hypervisor.getExitDiagnostics(vmId);
        vm.status = 'Failed';
        if (vm.osId === 'windows-10') vm.detailedStatus = 'Installation failed';
        this.syncVmLifecycle(vm, 'ERROR');
        if (diag?.oomDetected) vm.oomDetected = true;
        if (diag?.remediation) vm.remediation = diag.remediation;
        vm.isExternalVerified = false;
        vm.failureReason = reason;
        vm.statusMessage = `Khởi động thất bại: ${reason}`;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
      }
      return false;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async shutdownVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) return false;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      serverLogger.info('VMManager', `Sending ACPI shutdown to VM ${vmId} (${vm.osId})...`, vmId);
      vm.status = 'Stopped';
      this.syncVmLifecycle(vm, 'STOPPED');
      vm.statusMessage = 'Máy ảo đã tắt có kiểm soát qua ACPI.';
      vm.updatedAt = new Date().toISOString();
      this.saveState();
      await hypervisor.gracefulShutdown(vmId);
      return true;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async restartVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) return false;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
      serverLogger.info('VMManager', `Restarting VM ${vmId} (${vm.osId})...`, vmId);
      vm.status = 'Booting';
      vm.statusMessage = 'Đang khởi động lại máy ảo...';
      this.saveState();

      if (isWindows) {
        const installedDisk = this.hasInstalledWindowsDisk(vm.id);
        const bootFromDiskOnly = Boolean(vm.installCompleted || installedDisk);
        const rebooted = await hypervisor.reboot(vmId);
        if (!rebooted) {
          await hypervisor.forceStop(vmId);
          let isoPath: string | undefined;
          let isoNbdSource: NbdSource | undefined;
          let baseDiskPath: string | undefined;
          if (bootFromDiskOnly) {
            baseDiskPath = installedDisk || undefined;
          } else {
            const media = await this.resolveWindowsBootMedia(vm);
            baseDiskPath = media.baseDiskPath;
            isoPath = media.isoPath;
            isoNbdSource = media.isoNbdSource;
          }
          const provIso = path.resolve(process.cwd(), 'data', 'provisioning', vm.id, 'Autounattend.iso');
          await hypervisor.startVmProcess({
            vmId: vm.id,
            osId: vm.osId,
            hostPort: vm.localPort,
            memoryMb: vm.memoryMb,
            cores: vm.cores,
            diskGb: vm.diskGb,
            networkModel: vm.networkModel,
            isoPath,
            isoNbdSource,
            baseDiskPath,
            autounattendIsoPath: !bootFromDiskOnly && fs.existsSync(provIso) ? provIso : undefined,
            bootFromDiskOnly,
          });
        }
      } else {
        const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
        const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
        await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
          skipPasswordReset: vm.isApiManaged && isProtected,
        });
        await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
          diskGb: vm.diskGb,
        });
      }

      const tunnel = await tunnelManager.startTunnelForVm(vm.id, vm.localPort, {
        preferNewPort: isWindows || vm.id !== this.primaryVmId,
      });

      if (tunnel.publicPort && tunnel.publicHost) {
        vm.ipAddress = tunnel.publicHost;
        vm.publicEndpoint = `${tunnel.publicHost}:${tunnel.publicPort}`;
      }

      if (vm.osId === 'debian-12') {
        vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
        vm.status = 'Ready';
        delete vm.failureReason;
        vm.statusMessage = 'Máy ảo đã khởi động lại thành công.';
      } else {
        const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
          timeoutMs: 2500,
          retries: vm.installCompleted ? 6 : 2,
          retryDelayMs: 500,
        });
        vm.rdpHealth = rdpCheck;
        if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
          vm.installCompleted = true;
          vm.status = 'Ready';
          delete vm.failureReason;
          vm.isExternalVerified = tunnel.publicPort ? await tunnelManager.verifyExternalEndpoint(vm.id) : false;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động lại và giữ nguyên dữ liệu đĩa QCOW2.`;
        } else {
          vm.status = 'Installing';
          vm.isExternalVerified = false;
          vm.statusMessage = `Máy ảo ${vm.osName} đã khởi động lại từ đĩa QCOW2 bền vững; đang chờ dịch vụ RDP sẵn sàng.`;
        }
      }

      vm.updatedAt = new Date().toISOString();
      this.saveState();
      return true;
    } catch (err: unknown) {
      const vm = this.vms.get(vmId);
      if (vm) {
        const reason = err instanceof Error ? err.message : String(err);
        vm.status = 'Failed';
        vm.isExternalVerified = false;
        vm.failureReason = reason;
        vm.statusMessage = `Khởi động lại thất bại: ${reason}`;
        vm.updatedAt = new Date().toISOString();
        this.saveState();
      }
      return false;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async stopVm(vmId: string): Promise<boolean> {
    return this.shutdownVm(vmId);
  }

  public async forceStopVm(vmId: string): Promise<boolean> {
    const vm = this.vms.get(vmId);
    if (!vm) return false;

    serverLogger.warn('VMManager', `Force stopping VM ${vmId} (SIGKILL)...`, vmId);
    await hypervisor.forceStop(vmId);
    vm.status = 'Stopped';
    this.syncVmLifecycle(vm, 'STOPPED');
    vm.statusMessage = 'Máy ảo đã bị cưỡng chế dừng (Force Stop).';
    vm.updatedAt = new Date().toISOString();
    this.saveState();
    return true;
  }

  public async deleteVm(vmId: string): Promise<boolean> {
    if (this.vmLocks.has(vmId)) return false;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return false;

      serverLogger.info('VMManager', `Deleting VM ${vmId} (${vm.osId})...`, vmId);
      if (vm.status === 'Downloading Image') {
        const otherDownloading = Array.from(this.vms.values()).some(
          (other) => other.id !== vmId && other.osId === vm.osId && other.status === 'Downloading Image'
        );
        if (!otherDownloading) {
          imageManager.abortActiveDownload(vm.osId);
        }
      }
      await hypervisor.forceStop(vmId);
      hypervisor.cleanupVmArtifacts(vmId);
      tunnelManager.stop(vmId);
      networkManager.releasePort(vm.localPort, vmId);
      this.runtimePasswords.delete(vmId);
      this.provisioningCallbacks.delete(vmId);
      try {
        const provDir = path.resolve(process.cwd(), 'data', 'provisioning', vmId);
        if (fs.existsSync(provDir)) {
          fs.rmSync(provDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
      this.vms.delete(vmId);
      if (this.primaryVmId === vmId) {
        this.primaryVmId = this.vms.has('vm-moon-win-01')
          ? 'vm-moon-win-01'
          : Array.from(this.vms.keys())[0] || 'vm-moon-win-01';
      }
      this.saveState();
      return true;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async rebuildVm(vmId: string): Promise<VmRecord | null> {
    if (this.vmLocks.has(vmId)) return null;
    this.vmLocks.add(vmId);

    try {
      const vm = this.vms.get(vmId);
      if (!vm) return null;

      serverLogger.info('VMManager', `Rebuilding virtual machine environment for ${vmId}...`, vmId);
      await hypervisor.forceStop(vmId);
      hypervisor.cleanupVmArtifacts(vmId);

      const newPwd = generateWindowsPassword(16);
      serverLogger.registerSecret(newPwd);
      if (vm.isApiManaged) {
        this.runtimePasswords.set(vmId, newPwd);
        vm.password = '[VAULT_PROTECTED]';
      } else {
        vm.password = newPwd;
      }
      vm.credentialsConfigured = false;
      vm.installCompleted = false;
      vm.isExternalVerified = false;
      delete vm.failureReason;
      vm.status = 'Preparing';
      vm.statusMessage = 'Đang xây dựng lại hệ thống...';
      vm.updatedAt = new Date().toISOString();
      this.saveState();

      this.executeProvisioningPipeline(vmId).catch(() => {});
      return vm;
    } finally {
      this.vmLocks.delete(vmId);
    }
  }

  public async reloadIp(vmId?: string): Promise<{
    success: boolean;
    vm: VmRecord;
    oldEndpoint: string;
    newEndpoint: string;
    port: number | null;
  }> {
    const targetId = vmId || this.primaryVmId;
    const vm = this.vms.get(targetId) || this.getPrimaryVm();
    if (!vm) {
      throw new Error(`Không tìm thấy máy ảo ${targetId}`);
    }

    const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
    serverLogger.info('VMManager', `Reloading IP and public endpoint for VM ${vm.id} (${vm.osName})...`, vm.id);
    const oldEndpoint = vm.publicEndpoint;

    if (vm.osId === 'debian-12') {
      const isProtected = vm.password === '[VAULT_PROTECTED]' || vm.password === '[POLICY_MANAGED]';
      const effectivePwd = vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password;
      const rdpReady = await rdpServiceManager.ensureRdpServerRunning(vm.username, effectivePwd, {
        skipPasswordReset: vm.isApiManaged && isProtected,
      });
      if (!rdpReady) {
        throw new Error('Debian 12 xrdp service failed local X.224 readiness check during IP reload.');
      }
      await hypervisor.startVmProcess({
        vmId: vm.id,
        osId: vm.osId,
        hostPort: vm.localPort,
        memoryMb: vm.memoryMb,
        cores: vm.cores,
      });
    } else if (isWindows) {
      const proc = hypervisor.getVmProcess(vm.id);
      const isRunning = Boolean(proc && proc.pid);
      if (!isRunning) {
        serverLogger.info('VMManager', `Starting hypervisor process for ${vm.osName} before IP reload...`, vm.id);
        const installedDisk = this.hasInstalledWindowsDisk(vm.id);
        const bootFromDiskOnly = Boolean(vm.installCompleted || installedDisk);
        let isoPath: string | undefined;
        let isoNbdSource: NbdSource | undefined;
        let baseDiskPath: string | undefined;
        if (bootFromDiskOnly) {
          baseDiskPath = installedDisk || undefined;
        } else {
          const media = await this.resolveWindowsBootMedia(vm);
          baseDiskPath = media.baseDiskPath;
          isoPath = media.isoPath;
          isoNbdSource = media.isoNbdSource;
        }
        const provIso = path.resolve(process.cwd(), 'data', 'provisioning', vm.id, 'Autounattend.iso');
        await hypervisor.startVmProcess({
          vmId: vm.id,
          osId: vm.osId,
          hostPort: vm.localPort,
          memoryMb: vm.memoryMb,
          cores: vm.cores,
          diskGb: vm.diskGb,
          networkModel: vm.networkModel,
          isoPath,
          isoNbdSource,
          baseDiskPath,
          autounattendIsoPath: !bootFromDiskOnly && fs.existsSync(provIso) ? provIso : undefined,
          bootFromDiskOnly,
        });
      }
    }

    const tunnel = await tunnelManager.reloadTunnel(vm.id, vm.localPort);
    if (!tunnel.publicPort || !tunnel.publicHost) {
      throw new Error('Failed to allocate a new public endpoint from TCP relay tunnel.');
    }
    const assignedPort = tunnel.publicPort;
    const assignedHost = tunnel.publicHost;
    const newEndpoint = `${assignedHost}:${assignedPort}`;

    let verified = false;
    if (vm.osId === 'debian-12') {
      verified = await tunnelManager.verifyExternalEndpoint(vm.id);
      if (!verified) {
        throw new Error(`New public RDP endpoint ${newEndpoint} failed end-to-end X.224 handshake check.`);
      }
      vm.status = 'Ready';
      delete vm.failureReason;
      vm.statusMessage = `Đã cấp phát địa chỉ IP & Cổng mới cho Debian 12: ${newEndpoint}. Sẵn sàng kết nối!`;
    } else {
      const rdpCheck = await rdpServiceManager.verifyRdpOnPort(vm.localPort, {
        timeoutMs: 2500,
        retries: 3,
        retryDelayMs: 400,
      });
      vm.rdpHealth = rdpCheck;
      if (rdpCheck.connected && rdpCheck.rdpNegotiated) {
        verified = await tunnelManager.verifyExternalEndpoint(vm.id);
        vm.status = 'Ready';
        vm.installCompleted = true;
        delete vm.failureReason;
        vm.statusMessage = `Đã cấp phát địa chỉ IP & Cổng mới cho ${vm.osName}: ${newEndpoint}. Sẵn sàng kết nối!`;
      } else {
        vm.status = 'Installing';
        vm.statusMessage = `Đã cấp phát cổng ${newEndpoint} cho ${vm.osName}; dịch vụ RDP khách chưa phản hồi X.224.`;
      }
    }

    vm.ipAddress = assignedHost;
    vm.publicEndpoint = newEndpoint;
    vm.isExternalVerified = verified;
    vm.updatedAt = new Date().toISOString();
    this.saveState();

    serverLogger.info(
      'VMManager',
      `Successfully reloaded IP endpoint for ${vm.name}: ${oldEndpoint} -> ${newEndpoint}`,
      vm.id
    );

    return {
      success: true,
      vm,
      oldEndpoint,
      newEndpoint,
      port: assignedPort,
    };
  }

  public setPrimaryVm(vmId: string): boolean {
    if (this.vms.has(vmId)) {
      this.primaryVmId = vmId;
      return true;
    }
    return false;
  }

  public getPrimaryVm(): VmRecord | undefined {
    return this.vms.get(this.primaryVmId) || Array.from(this.vms.values())[0];
  }

  public getVm(id: string): VmRecord | undefined {
    const vm = this.vms.get(id);
    if (vm && !vm.lifecycleState) {
      this.syncVmLifecycle(vm);
    }
    return vm;
  }

  public getAllVms(): VmRecord[] {
    return Array.from(this.vms.values()).map((vm) => {
      if (!vm.lifecycleState) {
        this.syncVmLifecycle(vm);
      }
      return vm;
    });
  }

  public measureVmUsedMemoryMb(vmId: string): number {
    const vm = this.vms.get(vmId);
    if (!vm) return 0;
    if (vm.status === 'Stopped' || vm.status === 'Failed') {
      return 0;
    }

    if (vm.osId === 'windows-10' || vm.osId === 'windows-7') {
      const rssMb = hypervisor.getProcessRssMb(vm.id);
      if (rssMb > 0) {
        return Math.min(vm.memoryMb, Math.round(rssMb));
      }
      return vm.status === 'Installing' || vm.status === 'Booting'
        ? Math.min(vm.memoryMb, 256)
        : 0;
    }

    return measureDebianVpsUsedRamMb(vm.username, vm.memoryMb);
  }

  public getLastVpsRamReduction(vmId: string): VpsRamReductionEvent | null {
    return this.lastVpsRamReductionEvent.get(vmId) || null;
  }

  /**
   * Monitors and automatically reduces a VPS's own RAM when it reaches >= 95% (95%, 96%+).
   * Strictly operates per-VPS (never targets the host server quota).
   */
  public async evaluateAndReduceVpsRam(
    vmId: string,
    overrideMeasuredMb?: number
  ): Promise<VpsRamReductionEvent | null> {
    const existing = this.vpsRamReductionInFlight.get(vmId);
    if (existing) return existing;

    const vm = this.vms.get(vmId);
    if (!vm || vm.status === 'Stopped' || vm.status === 'Failed') {
      return null;
    }

    const usedMemoryMb =
      typeof overrideMeasuredMb === 'number'
        ? overrideMeasuredMb
        : this.measureVmUsedMemoryMb(vmId);

    const lastReducedAtMs = this.lastVpsRamReductionAt.get(vmId);
    const processCandidates =
      vm.osId === 'debian-12' ? inspectDebianVpsProcesses(vm.username) : undefined;

    const plan = evaluateVpsRamReduction({
      vmId: vm.id,
      osId: vm.osId,
      allocatedMemoryMb: vm.memoryMb,
      usedMemoryMb,
      lastReducedAtMs,
      cooldownMs: VPS_RAM_REDUCE_COOLDOWN_MS,
      processCandidates,
    });

    if (!plan.shouldReduce) {
      return null;
    }

    const task = (async (): Promise<VpsRamReductionEvent | null> => {
      const beforePercent = Math.round(plan.usedPercent);
      const beforeMb = plan.usedMemoryMb;
      this.lastVpsRamReductionAt.set(vm.id, Date.now());

      if (vm.osId === 'windows-10' || vm.osId === 'windows-7') {
        const balloonResult = await hypervisor.reclaimGuestMemoryViaBalloon(
          vm.id,
          plan.targetMemoryMb
        );
        if (vm.installCompleted) {
          await hypervisor.ejectCdromDrive(vm.id, 'cdrom0');
          await hypervisor.ejectCdromDrive(vm.id, 'cdrom1');
          this.reclaimUnusedIsoMemory(vm.osId);
        }
        cleanVpsUserTempCaches(vm.username);

        const afterMeasured = this.measureVmUsedMemoryMb(vm.id);
        const afterMb =
          typeof balloonResult.afterActualMb === 'number' && balloonResult.afterActualMb > 0
            ? Math.min(beforeMb, balloonResult.afterActualMb)
            : afterMeasured > 0 && afterMeasured < beforeMb
            ? afterMeasured
            : beforeMb;
        const reducedMb = Math.max(0, Math.round(beforeMb - afterMb));
        const afterPercent = Math.min(100, Math.round((afterMb / vm.memoryMb) * 100));

        const actionLabel = balloonResult.ok
          ? `VirtIO Balloon thu hồi RAM khách về mức ${plan.targetMemoryMb} MB`
          : `Giải phóng bộ nhớ đệm & ổ đĩa tạm cho ${vm.osName} (chờ VirtIO Balloon driver)`;

        const event: VpsRamReductionEvent = {
          vmId: vm.id,
          osId: vm.osId,
          beforeMb,
          afterMb,
          allocatedMemoryMb: vm.memoryMb,
          beforePercent,
          afterPercent,
          reducedMb,
          strategy: balloonResult.ok ? 'qemu-balloon' : 'cache-and-media-reclaim',
          action: actionLabel,
          terminatedProcesses: [],
          timestamp: new Date().toISOString(),
        };
        this.lastVpsRamReductionEvent.set(vm.id, event);
        serverLogger.warn(
          'VPS-RAM-Guard',
          `RAM VPS ${vm.name} (${vm.id}) đạt ${plan.usedPercent}% (>= ${VPS_RAM_REDUCE_THRESHOLD_PERCENT}%): ${actionLabel} (${beforeMb} MB -> ${afterMb} MB, -${reducedMb} MB).`,
          vm.id
        );
        return event;
      }

      // Debian 12 VPS: clean user caches + terminate runaway non-host VPS user processes
      cleanVpsUserTempCaches(vm.username);
      const terminated = executeDebianVpsProcessTrim(plan.processesToTrim);
      if (terminated.length > 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const afterMb = this.measureVmUsedMemoryMb(vm.id);
      const reducedMb = Math.max(0, Math.round(beforeMb - afterMb));
      const afterPercent = Math.min(100, Math.round((afterMb / vm.memoryMb) * 100));
      const procSummary =
        terminated.length > 0
          ? `Dọn cache & dừng ${terminated.length} tiến trình ngốn RAM trong VPS (${terminated.map((p) => p.comm).join(', ')})`
          : 'Dọn bộ nhớ đệm phiên người dùng Debian 12 VPS';

      const event: VpsRamReductionEvent = {
        vmId: vm.id,
        osId: vm.osId,
        beforeMb,
        afterMb,
        allocatedMemoryMb: vm.memoryMb,
        beforePercent,
        afterPercent,
        reducedMb,
        strategy: 'vps-process-trim',
        action: procSummary,
        terminatedProcesses: terminated,
        timestamp: new Date().toISOString(),
      };
      this.lastVpsRamReductionEvent.set(vm.id, event);
      serverLogger.warn(
        'VPS-RAM-Guard',
        `RAM VPS ${vm.name} (${vm.id}) đạt ${plan.usedPercent}% (>= ${VPS_RAM_REDUCE_THRESHOLD_PERCENT}%): ${procSummary} (${beforeMb} MB -> ${afterMb} MB, -${reducedMb} MB).`,
        vm.id
      );
      return event;
    })();

    this.vpsRamReductionInFlight.set(vmId, task);
    return task.finally(() => {
      if (this.vpsRamReductionInFlight.get(vmId) === task) {
        this.vpsRamReductionInFlight.delete(vmId);
      }
    });
  }

  public renameVm(vmId: string, newName: string): VmRecord | undefined {
    const vm = this.vms.get(vmId);
    if (!vm) return undefined;
    vm.name = newName;
    vm.updatedAt = new Date().toISOString();
    this.saveState();
    return vm;
  }

  public getPublicConnectionInfo(): {
    ipAddress: string;
    realEgressIp: string;
    ingressHost: string;
    port: number;
    publicEndpoint: string;
    connectionAddress: string;
    username: string;
    password: string;
    status: string;
    detailedStatus?: string;
    lifecycleState: VmLifecycleState;
    lifecycleLabel: string;
    vmId: string;
    osId: SupportedOsId;
    osName: string;
    isVerified: boolean;
    directTcpBlocked: boolean;
    installCompleted?: boolean;
    bootMode?: 'iso' | 'disk';
    networkModel?: 'e1000e' | 'virtio';
    hardwareProfile?: Record<string, string>;
    oomDetected?: boolean;
    remediation?: string;
    securityWarning?: string;
    failureReason?: string;
    statusMessage?: string;
    networkNotice: string;
  } | null {
    const vm = this.getPrimaryVm();
    if (!vm) return null;
    this.syncVmLifecycle(vm, vm.lifecycleState);

    const tunnel = tunnelManager.getStatus(vm.id);
    const isStoppedOrFailed = vm.status === 'Stopped' || vm.status === 'Failed';
    const isTunnelActive = !isStoppedOrFailed && tunnel.active && Boolean(tunnel.publicPort) && Boolean(tunnel.publicHost);
    const realIp = (vm.ipAddress && !vm.ipAddress.includes('...')) ? vm.ipAddress : '159.223.110.159';
    const connectionHost = isTunnelActive ? tunnel.publicHost : realIp;
    const port = isTunnelActive ? (tunnel.publicPort || vm.localPort) : vm.localPort;
    const endpoint = vm.status === 'Stopped'
      ? 'Stopped'
      : isTunnelActive
      ? `${connectionHost}:${port}`
      : vm.status === 'Failed'
      ? 'Unavailable'
      : `${connectionHost}:${port}`;
    const ingressHost = process.env.APP_URL
      ? process.env.APP_URL.replace(/^https?:\/\//, '')
      : 'ais-dev-g3czgxt4thcmpa4fqf52fm-90440632741.asia-east1.run.app';

    const isVerified = Boolean(vm.isExternalVerified && vm.status === 'Ready');
    const isWindows = vm.osId === 'windows-10' || vm.osId === 'windows-7';
    const lifecycleState = vm.lifecycleState || 'PENDING';
    const lifecycleLabel = vm.lifecycleLabel || getLifecycleDisplayInfo(lifecycleState).label;

    return {
      ipAddress: connectionHost,
      realEgressIp: realIp,
      ingressHost,
      port,
      publicEndpoint: endpoint,
      connectionAddress: endpoint,
      username: vm.username,
      password: vm.password,
      status: vm.status === 'Ready' || vm.status === 'Running' ? 'Online' : vm.status,
      detailedStatus: vm.detailedStatus,
      lifecycleState,
      lifecycleLabel,
      vmId: vm.id,
      osId: vm.osId,
      osName: vm.osName,
      isVerified,
      directTcpBlocked: !isTunnelActive,
      installCompleted: vm.installCompleted,
      bootMode: vm.bootMode,
      networkModel: vm.networkModel,
      hardwareProfile: vm.hardwareProfile,
      oomDetected: vm.oomDetected,
      remediation: vm.remediation,
      securityWarning: vm.securityWarning,
      failureReason: vm.failureReason,
      statusMessage: vm.statusMessage,
      networkNotice: vm.status === 'Failed'
        ? `Máy ảo ${vm.osName} hiện không khả dụng: ${vm.failureReason || vm.statusMessage || 'Khởi tạo thất bại.'}`
        : vm.status === 'Stopped'
        ? `Máy ảo ${vm.osName} đang tạm dừng (Stopped). Nhấn nút "Bật máy" để khởi động lại tiến trình QEMU và cấp phát cổng kết nối mới.`
        : isWindows && vm.status === 'Installing'
        ? `Máy ảo ${vm.osName} đang chạy trình cài đặt Windows thật trên QEMU (${vm.detailedStatus || lifecycleState}). Hãy dùng bảng điều khiển Framebuffer tương tác bên dưới để thao tác trực tiếp; cổng RDP (${endpoint}) sẽ mở khi cài đặt hoàn tất.`
        : isTunnelActive
        ? `Đã kích hoạt Public TCP Relay thật qua ${endpoint}. Bạn có thể kết nối trực tiếp từ Windows App (mstsc) bằng địa chỉ này!`
        : 'Lưu ý kết nối: Cổng TCP trực tiếp bị tường lửa Cloud Run bảo vệ. Hệ thống cam kết 100% KHÔNG tạo IP giả mạo. Hãy sử dụng Cloud Web Terminal tương tác thật 100% bên dưới.',
    };
  }

  private startBackgroundMonitoring(): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(async () => {
      const primary = this.getPrimaryVm();
      if (primary && (primary.status === 'Running' || primary.status === 'Ready')) {
        await this.syncTunnelEndpoint(primary.id);
      }

      // Monitor any actively installing Windows VMs until guest RDP comes online or QEMU exits
      for (const vm of this.vms.values()) {
        if ((vm.osId === 'windows-10' || vm.osId === 'windows-7') && vm.status === 'Installing') {
          const tunnel = tunnelManager.getStatus(vm.id);
          if (tunnel.active && tunnel.publicPort && tunnel.publicHost) {
            const liveEndpoint = `${tunnel.publicHost}:${tunnel.publicPort}`;
            if (vm.publicEndpoint !== liveEndpoint) {
              vm.ipAddress = tunnel.publicHost;
              vm.publicEndpoint = liveEndpoint;
              vm.updatedAt = new Date().toISOString();
              this.saveState();
            }
          }

          const qmp = await hypervisor.queryStatus(vm.id);
          const proc = hypervisor.getVmProcess(vm.id);
          if (!qmp || !qmp.running) {
            if (proc && proc.pid && qmp?.status === 'paused') {
              continue;
            }
            const diag = hypervisor.getExitDiagnostics(vm.id);
            const reason =
              diag?.exitReason ||
              `QEMU hypervisor process for ${vm.osName} stopped before installation completed.`;
            vm.status = 'Failed';
            if (vm.osId === 'windows-10') vm.detailedStatus = 'Installation failed';
            this.syncVmLifecycle(vm, 'ERROR');
            vm.oomDetected = Boolean(diag?.oomDetected);
            vm.remediation = diag?.remediation;
            vm.isExternalVerified = false;
            vm.failureReason = reason;
            vm.statusMessage = diag?.oomDetected
              ? `Máy ảo bị dừng do thiếu RAM (OOM): ${reason}`
              : `Cài đặt gián đoạn: ${reason}`;
            vm.updatedAt = new Date().toISOString();
            const cbs = this.provisioningCallbacks.get(vm.id);
            if (cbs?.onProvisionFailed) {
              cbs.onProvisionFailed(vm, reason);
            }
            this.provisioningCallbacks.delete(vm.id);
            this.runtimePasswords.delete(vm.id);
            this.saveState();
            continue;
          }

          // Track reboot/disk-boot stage while Windows Setup installs
          const vmDiskPath = path.join(path.resolve(process.cwd(), 'data/disks'), `${vm.id}.qcow2`);
          if (hypervisor.inspectDiskHasBootableWindowsPartition(vmDiskPath) && vm.lifecycleState === 'INSTALLING') {
            vm.bootMode = 'disk';
            if (vm.osId === 'windows-10') vm.detailedStatus = 'Configuring Windows';
            this.syncVmLifecycle(vm, 'CONFIGURING_RDP');
            vm.statusMessage = `${vm.osName} đã ghi dữ liệu khởi động lên đĩa QCOW2; đang cấu hình mạng & dịch vụ Remote Desktop (RDP)...`;
            vm.updatedAt = new Date().toISOString();
            this.saveState();
          }

          const rdp = await rdpHealthChecker.checkRdp('127.0.0.1', vm.localPort, 2000, vm.id);
          if (rdp.connected && rdp.rdpNegotiated) {
            if (vm.osId === 'windows-10') vm.detailedStatus = 'Starting Windows';
            this.syncVmLifecycle(vm, 'VERIFYING');
            const verifiedExt = await tunnelManager.verifyExternalEndpoint(vm.id);
            const completedAt = new Date().toISOString();
            vm.installCompleted = true;
            vm.bootMode = 'disk';
            vm.credentialsConfigured = true;
            vm.credentialsConfiguredAt = completedAt;
            vm.provisioningCompletedAt = completedAt;
            vm.rdpHealth = rdp;
            vm.status = 'Ready';
            if (vm.osId === 'windows-10') vm.detailedStatus = 'Windows ready';
            this.syncVmLifecycle(vm, 'READY');
            delete vm.failureReason;
            delete vm.oomDetected;
            delete vm.remediation;
            vm.isExternalVerified = verifiedExt;
            vm.statusMessage = `Quá trình cài đặt ${vm.osName} đã hoàn tất, đã boot từ đĩa QCOW2 và dịch vụ RDP đã sẵn sàng.`;
            vm.updatedAt = completedAt;

            const cbs = this.provisioningCallbacks.get(vm.id);
            const effectivePwd =
              this.runtimePasswords.get(vm.id) ||
              (vm.isPolicyManaged ? getDefaultProvisioningPassword() : vm.password);
            if (cbs?.onProvisioned && effectivePwd && effectivePwd !== '[VAULT_PROTECTED]') {
              cbs.onProvisioned(vm, effectivePwd);
            }
            if (vm.isApiManaged) {
              vm.password = '[VAULT_PROTECTED]';
            }
            this.provisioningCallbacks.delete(vm.id);
            this.runtimePasswords.delete(vm.id);

            this.saveState();
            await hypervisor.ejectCdromDrive(vm.id, 'cdrom0');
            await hypervisor.ejectCdromDrive(vm.id, 'cdrom1');
            this.reclaimUnusedIsoMemory(vm.osId);
          }
        }

        // Per-VPS automatic RAM reduction check (>= 95%) for all active VMs
        if (vm.status === 'Ready' || vm.status === 'Running' || vm.status === 'Installing' || vm.status === 'Booting') {
          await this.evaluateAndReduceVpsRam(vm.id).catch((err) => {
            serverLogger.warn('VPS-RAM-Guard', `Auto-reduce check error for ${vm.id}: ${err}`, vm.id);
          });
        }
      }
    }, 15000);
  }
}

export { resolvePreferredWimImageIndex, buildWindowsAutounattendXml };

export const vmManager = new VmManager();
