import fs from 'node:fs';
import os from 'node:os';
import { getContainerMemAvailableBytes } from './dockurEngine';

export const MAX_VM_RAM_RATIO = 0.9; // 90% max for all VMs
export const MIN_HOST_RAM_RESERVE_RATIO = 0.1; // 10% min reserved for host OS & services
export const MAX_HOST_CPU_USAGE_PERCENT = 95; // 95% max total CPU usage
export const MIN_HOST_CPU_RESERVE_PERCENT = 5; // 5% min reserved for host OS & services

export interface RamAdmissionInput {
  hostTotalMb: number;
  hostAvailableMb: number;
  activeVmsRamMb: number;
  requestedRamMb: number;
  hypervisorOverheadMb?: number;
}

export interface RamAdmissionResult {
  allowed: boolean;
  code?: 'RAM_LIMIT_90_EXCEEDED' | 'INSUFFICIENT_HOST_RAM';
  hostTotalMb: number;
  maxVmRamMb: number;
  reservedHostMb: number;
  activeVmsRamMb: number;
  requestedRamMb: number;
  hypervisorOverheadMb: number;
  remainingByQuotaMb: number;
  remainingByHostAvailableMb: number;
  availableForVmMb: number;
  reason?: string;
}

export interface CpuAdmissionInput {
  currentCpuUsagePercent: number;
  totalHostCores: number;
  activeVmCores: number;
  requestedCores: number;
}

export interface CpuAdmissionResult {
  allowed: boolean;
  code?: 'CPU_LIMIT_95_EXCEEDED' | 'INVALID_CPU_CORES';
  currentCpuUsagePercent: number;
  maxCpuUsagePercent: number;
  reservedHostCpuPercent: number;
  totalHostCores: number;
  activeVmCores: number;
  requestedCores: number;
  reason?: string;
}

export interface ActiveVmResourceUsage {
  vmId: string;
  osId: string;
  memoryMb: number;
  cores: number;
  status: string;
  pid?: number | null;
}

export interface HostResourceSnapshot {
  timestamp: string;
  ram: {
    hostTotalMb: number;
    hostAvailableMb: number;
    maxVmRamMb: number;
    reservedHostMb: number;
    activeVmsRamMb: number;
    availableForVmMb: number;
    usedPercentOfTotal: number;
    vmQuotaUsedPercent: number;
    reservePercent: number;
  };
  cpu: {
    totalHostCores: number;
    configuredVmCores: number;
    realUsagePercent: number;
    maxAllowedUsagePercent: number;
    reservedHostPercent: number;
    throttled: boolean;
  };
}

/**
 * Pure RAM admission rule:
 * - Combined VM RAM must NEVER exceed 90% of hostTotalMb (always reserving >= 10% for host OS & services).
 * - Must also fit within real hostAvailableMb minus the 10% reserve so host services never starve or OOM.
 * - Never overcommits beyond the 90% limit.
 */
export function evaluateRamAdmission(input: RamAdmissionInput): RamAdmissionResult {
  const hostTotalMb = Math.max(0, Math.floor(input.hostTotalMb));
  const hostAvailableMb = Math.max(0, Math.floor(input.hostAvailableMb));
  const activeVmsRamMb = Math.max(0, Math.floor(input.activeVmsRamMb));
  const requestedRamMb = Math.max(0, Math.floor(input.requestedRamMb));
  const hypervisorOverheadMb = Math.max(0, Math.floor(input.hypervisorOverheadMb || 0));

  const maxVmRamMb = Math.floor(hostTotalMb * MAX_VM_RAM_RATIO);
  const reservedHostMb = Math.max(Math.ceil(hostTotalMb * MIN_HOST_RAM_RESERVE_RATIO), hostTotalMb - maxVmRamMb);

  const remainingByQuotaMb = Math.max(0, maxVmRamMb - activeVmsRamMb);
  const remainingByHostAvailableMb = Math.max(0, hostAvailableMb - reservedHostMb);
  const availableForVmMb = Math.min(remainingByQuotaMb, remainingByHostAvailableMb);

  const neededMb = requestedRamMb + hypervisorOverheadMb;

  if (activeVmsRamMb + requestedRamMb > maxVmRamMb) {
    return {
      allowed: false,
      code: 'RAM_LIMIT_90_EXCEEDED',
      hostTotalMb,
      maxVmRamMb,
      reservedHostMb,
      activeVmsRamMb,
      requestedRamMb,
      hypervisorOverheadMb,
      remainingByQuotaMb,
      remainingByHostAvailableMb,
      availableForVmMb,
      reason: `Vượt giới hạn 90% RAM cho phép (${maxVmRamMb} MB / ${hostTotalMb} MB, bắt buộc chừa tối thiểu ${reservedHostMb} MB [10%] cho máy chủ). Các VM đang dùng ${activeVmsRamMb} MB, chỉ còn cấp tối đa ${remainingByQuotaMb} MB (yêu cầu ${requestedRamMb} MB).`,
    };
  }

  if (neededMb > remainingByHostAvailableMb) {
    return {
      allowed: false,
      code: 'INSUFFICIENT_HOST_RAM',
      hostTotalMb,
      maxVmRamMb,
      reservedHostMb,
      activeVmsRamMb,
      requestedRamMb,
      hypervisorOverheadMb,
      remainingByQuotaMb,
      remainingByHostAvailableMb,
      availableForVmMb,
      reason: `Không đủ RAM khả dụng thực tế để chừa 10% cho hệ điều hành máy chủ (${reservedHostMb} MB). RAM trống hiện tại: ${hostAvailableMb} MB, khả dụng cho VM sau khi chừa 10%: ${remainingByHostAvailableMb} MB, cần: ${neededMb} MB.`,
    };
  }

  return {
    allowed: true,
    hostTotalMb,
    maxVmRamMb,
    reservedHostMb,
    activeVmsRamMb,
    requestedRamMb,
    hypervisorOverheadMb,
    remainingByQuotaMb,
    remainingByHostAvailableMb,
    availableForVmMb,
  };
}

/**
 * Pure CPU admission rule:
 * - Tracks REAL host CPU usage percentage (not merely configured vCPU count).
 * - Blocks VM creation / start / CPU scaling when real CPU usage >= 95% (reserving >= 5% for host).
 * - Automatically allows again once real CPU usage drops below 95%.
 */
export function evaluateCpuAdmission(input: CpuAdmissionInput): CpuAdmissionResult {
  const currentCpuUsagePercent = Math.max(0, Math.min(100, Number(input.currentCpuUsagePercent.toFixed(1))));
  const totalHostCores = Math.max(1, Math.floor(input.totalHostCores));
  const activeVmCores = Math.max(0, Math.floor(input.activeVmCores));
  const requestedCores = Math.max(1, Math.floor(input.requestedCores));

  if (requestedCores > totalHostCores) {
    return {
      allowed: false,
      code: 'INVALID_CPU_CORES',
      currentCpuUsagePercent,
      maxCpuUsagePercent: MAX_HOST_CPU_USAGE_PERCENT,
      reservedHostCpuPercent: MIN_HOST_CPU_RESERVE_PERCENT,
      totalHostCores,
      activeVmCores,
      requestedCores,
      reason: `Số CPU yêu cầu (${requestedCores} cores) vượt quá tổng số lõi vật lý của máy chủ (${totalHostCores} cores).`,
    };
  }

  if (currentCpuUsagePercent >= MAX_HOST_CPU_USAGE_PERCENT) {
    return {
      allowed: false,
      code: 'CPU_LIMIT_95_EXCEEDED',
      currentCpuUsagePercent,
      maxCpuUsagePercent: MAX_HOST_CPU_USAGE_PERCENT,
      reservedHostCpuPercent: MIN_HOST_CPU_RESERVE_PERCENT,
      totalHostCores,
      activeVmCores,
      requestedCores,
      reason: `Mức sử dụng CPU thực tế của máy chủ đang là ${currentCpuUsagePercent}% (đạt ngưỡng tối đa ${MAX_HOST_CPU_USAGE_PERCENT}%, phải chừa tối thiểu ${MIN_HOST_CPU_RESERVE_PERCENT}% cho hệ điều hành máy chủ). Vui lòng chờ CPU giảm xuống dưới ${MAX_HOST_CPU_USAGE_PERCENT}% trước khi tạo hoặc bật thêm VM.`,
    };
  }

  return {
    allowed: true,
    currentCpuUsagePercent,
    maxCpuUsagePercent: MAX_HOST_CPU_USAGE_PERCENT,
    reservedHostCpuPercent: MIN_HOST_CPU_RESERVE_PERCENT,
    totalHostCores,
    activeVmCores,
    requestedCores,
  };
}

export function parseProcStatCpuSample(procStatContent: string): { idle: number; total: number } | null {
  const line = procStatContent.split('\n').find((l) => /^cpu\s+/.test(l));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((acc, v) => acc + v, 0);
  if (total <= 0) return null;
  return { idle, total };
}

export function computeCpuUsageFromSamples(
  prev: { idle: number; total: number },
  curr: { idle: number; total: number }
): number {
  const totalDelta = curr.total - prev.total;
  const idleDelta = curr.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  const busyRatio = Math.max(0, Math.min(1, (totalDelta - idleDelta) / totalDelta));
  return Math.round(busyRatio * 1000) / 10;
}

class HostResourceManager {
  private prevSample: { idle: number; total: number } | null = null;
  private latestCpuPercent = 0;
  private lastSampledAt = 0;
  private samplerTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.prevSample = this.readCpuSample();
    this.lastSampledAt = Date.now();
    this.latestCpuPercent = this.estimateInitialCpuPercent(this.prevSample);
  }

  private readCpuSample(): { idle: number; total: number } | null {
    try {
      if (fs.existsSync('/proc/stat')) {
        const parsed = parseProcStatCpuSample(fs.readFileSync('/proc/stat', 'utf8'));
        if (parsed) return parsed;
      }
    } catch {
      // fallback to os.cpus()
    }
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return null;
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    }
    return total > 0 ? { idle, total } : null;
  }

  private estimateInitialCpuPercent(sample: { idle: number; total: number } | null): number {
    const load1m = os.loadavg()[0] || 0;
    if (load1m > 0) {
      const cores = os.cpus().length || 1;
      return Math.min(100, Math.max(0, Math.round((load1m / cores) * 1000) / 10));
    }
    if (sample && sample.total > 0) {
      const ratio = Math.max(0, Math.min(1, (sample.total - sample.idle) / sample.total));
      return Math.round(ratio * 1000) / 10;
    }
    return 0;
  }

  public startCpuSampler(): void {
    if (this.samplerTimer) return;
    this.samplerTimer = setInterval(() => {
      this.sampleRealCpuUsagePercent(true);
    }, 2000);
    this.samplerTimer.unref?.();
  }

  public sampleRealCpuUsagePercent(force = false): number {
    const now = Date.now();
    if (!force && now - this.lastSampledAt < 1500) {
      return this.latestCpuPercent;
    }
    const curr = this.readCpuSample();
    if (!curr) {
      return this.latestCpuPercent;
    }
    if (this.prevSample && curr.total - this.prevSample.total >= 4) {
      this.latestCpuPercent = computeCpuUsageFromSamples(this.prevSample, curr);
      this.prevSample = curr;
      this.lastSampledAt = now;
    } else if (!this.prevSample) {
      this.prevSample = curr;
      this.lastSampledAt = now;
    }
    return this.latestCpuPercent;
  }

  public getRealCpuUsagePercent(): number {
    return this.sampleRealCpuUsagePercent(false);
  }

  public checkRamAdmission(params: {
    activeVms: ActiveVmResourceUsage[];
    requestedRamMb: number;
    excludeVmId?: string;
    hypervisorOverheadMb?: number;
  }): RamAdmissionResult {
    const hostTotalMb = Math.floor(os.totalmem() / (1024 * 1024));
    const hostAvailableMb = Math.floor(getContainerMemAvailableBytes() / (1024 * 1024));
    const activeVmsRamMb = this.sumActiveVmRamMb(params.activeVms, params.excludeVmId);

    return evaluateRamAdmission({
      hostTotalMb,
      hostAvailableMb,
      activeVmsRamMb,
      requestedRamMb: params.requestedRamMb,
      hypervisorOverheadMb: params.hypervisorOverheadMb,
    });
  }

  public checkCpuAdmission(params: {
    activeVms: ActiveVmResourceUsage[];
    requestedCores: number;
    excludeVmId?: string;
  }): CpuAdmissionResult {
    const totalHostCores = os.cpus().length || 1;
    const activeVmCores = this.sumActiveVmCores(params.activeVms, params.excludeVmId);
    const currentCpuUsagePercent = this.getRealCpuUsagePercent();

    return evaluateCpuAdmission({
      currentCpuUsagePercent,
      totalHostCores,
      activeVmCores,
      requestedCores: params.requestedCores,
    });
  }

  public sumActiveVmRamMb(activeVms: ActiveVmResourceUsage[], excludeVmId?: string): number {
    let sum = 0;
    for (const vm of activeVms) {
      if (excludeVmId && vm.vmId === excludeVmId) continue;
      if (this.isVmConsumingHostResources(vm)) {
        sum += Math.max(0, vm.memoryMb || 0);
      }
    }
    return sum;
  }

  public sumActiveVmCores(activeVms: ActiveVmResourceUsage[], excludeVmId?: string): number {
    let sum = 0;
    for (const vm of activeVms) {
      if (excludeVmId && vm.vmId === excludeVmId) continue;
      if (this.isVmConsumingHostResources(vm)) {
        sum += Math.max(0, vm.cores || 0);
      }
    }
    return sum;
  }

  private isVmConsumingHostResources(vm: ActiveVmResourceUsage): boolean {
    if (vm.status === 'Stopped' || vm.status === 'Failed') return false;
    // Active VMs (Queued, Preparing, Installing, Booting, Running, Ready) reserve/consume RAM
    if (vm.osId === 'debian-12') {
      return vm.status === 'Ready' || vm.status === 'Running' || vm.status === 'Booting' || vm.status === 'Queued' || vm.status === 'Preparing';
    }
    // For Windows QEMU VMs, count running PIDs as well as actively provisioning ones
    if (vm.pid && vm.pid > 0) return true;
    return (
      vm.status === 'Queued' ||
      vm.status === 'Preparing' ||
      vm.status === 'Downloading Image' ||
      vm.status === 'Creating Disk' ||
      vm.status === 'Installing' ||
      vm.status === 'Booting' ||
      vm.status === 'Running' ||
      vm.status === 'Ready'
    );
  }

  public getSnapshot(activeVms: ActiveVmResourceUsage[]): HostResourceSnapshot {
    const hostTotalMb = Math.floor(os.totalmem() / (1024 * 1024));
    const hostAvailableMb = Math.floor(getContainerMemAvailableBytes() / (1024 * 1024));
    const activeVmsRamMb = this.sumActiveVmRamMb(activeVms);
    const maxVmRamMb = Math.floor(hostTotalMb * MAX_VM_RAM_RATIO);
    const reservedHostMb = Math.max(Math.ceil(hostTotalMb * MIN_HOST_RAM_RESERVE_RATIO), hostTotalMb - maxVmRamMb);
    const remainingByQuotaMb = Math.max(0, maxVmRamMb - activeVmsRamMb);
    const remainingByHostAvailMb = Math.max(0, hostAvailableMb - reservedHostMb);
    const availableForVmMb = Math.min(remainingByQuotaMb, remainingByHostAvailMb);
    const usedHostMb = Math.max(0, hostTotalMb - hostAvailableMb);

    const totalHostCores = os.cpus().length || 1;
    const configuredVmCores = this.sumActiveVmCores(activeVms);
    const realUsagePercent = this.getRealCpuUsagePercent();

    return {
      timestamp: new Date().toISOString(),
      ram: {
        hostTotalMb,
        hostAvailableMb,
        maxVmRamMb,
        reservedHostMb,
        activeVmsRamMb,
        availableForVmMb,
        usedPercentOfTotal: hostTotalMb > 0 ? Math.round((usedHostMb / hostTotalMb) * 1000) / 10 : 0,
        vmQuotaUsedPercent: maxVmRamMb > 0 ? Math.min(100, Math.round((activeVmsRamMb / maxVmRamMb) * 1000) / 10) : 0,
        reservePercent: Math.round(MIN_HOST_RAM_RESERVE_RATIO * 100),
      },
      cpu: {
        totalHostCores,
        configuredVmCores,
        realUsagePercent,
        maxAllowedUsagePercent: MAX_HOST_CPU_USAGE_PERCENT,
        reservedHostPercent: MIN_HOST_CPU_RESERVE_PERCENT,
        throttled: realUsagePercent >= MAX_HOST_CPU_USAGE_PERCENT,
      },
    };
  }
}

export const hostResourceManager = new HostResourceManager();
