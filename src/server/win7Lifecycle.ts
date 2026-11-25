import type { SupportedOsId } from './imageManager';

export type VmLifecycleState =
  | 'PENDING'
  | 'DOWNLOADING_ISO'
  | 'PREPARING'
  | 'INSTALLING'
  | 'REBOOTING'
  | 'BOOTING'
  | 'CONFIGURING_NETWORK'
  | 'CONFIGURING_RDP'
  | 'VERIFYING'
  | 'READY'
  | 'STOPPED'
  | 'ERROR';

export interface CgroupOomStats {
  oomKillDisable: boolean;
  underOom: boolean;
  oomKillCount: number;
}

export type ExitCauseCode =
  | 'CONTAINER_OOM_KILL'
  | 'HOST_MEMORY_EXHAUSTED'
  | 'DISK_FULL'
  | 'MISSING_MEDIA'
  | 'ACPI_SHUTDOWN'
  | 'SIGNAL_TERMINATED'
  | 'QEMU_RUNTIME_ERROR';

export interface QemuExitClassification {
  oomDetected: boolean;
  causeCode: ExitCauseCode;
  message: string;
  remediation?: string;
}

export interface VmMemoryBudgetInput {
  osId: SupportedOsId;
  requestedMemoryMb: number;
  hostTotalMb: number;
  hostAvailableMb: number;
  isMemoryBackedOverlay: boolean;
  existingDiskMb: number;
  attachInstallerIso: boolean;
  otherActiveQemuMb?: number;
  hostReserveMb?: number;
  win7MaxRamMb?: number;
  win10MaxRamMb?: number;
}

export interface VmMemoryBudgetResult {
  allowed: boolean;
  code?: 'INSUFFICIENT_HOST_MEMORY' | 'OVERCOMMIT_PREVENTED';
  allocatedMemoryMb: number;
  requestedMemoryMb: number;
  adjusted: boolean;
  hostReserveMb: number;
  qemuOverheadMb: number;
  expectedDiskGrowthMb: number;
  estimatedTotalFootprintMb: number;
  headroomAfterMb: number;
  reason?: string;
  remediation?: string;
}

export interface IsoChecksumEvaluation {
  verified: boolean;
  status: 'VERIFIED' | 'MISMATCH' | 'UNAVAILABLE';
  reason?: string;
}

export function mapVmStatusToLifecycleState(
  status: string,
  opts?: {
    lifecycleHint?: VmLifecycleState;
    installCompleted?: boolean;
    rdpLocalConnected?: boolean;
    isExternalVerified?: boolean;
    isRebooting?: boolean;
  }
): VmLifecycleState {
  if (opts?.lifecycleHint) {
    // Allow explicit granular stage when status matches active work
    if (
      status === 'Installing' &&
      (opts.lifecycleHint === 'REBOOTING' ||
        opts.lifecycleHint === 'BOOTING' ||
        opts.lifecycleHint === 'CONFIGURING_NETWORK' ||
        opts.lifecycleHint === 'CONFIGURING_RDP' ||
        opts.lifecycleHint === 'VERIFYING')
    ) {
      return opts.lifecycleHint;
    }
    if (
      status === 'Booting' &&
      (opts.lifecycleHint === 'REBOOTING' ||
        opts.lifecycleHint === 'CONFIGURING_NETWORK' ||
        opts.lifecycleHint === 'CONFIGURING_RDP' ||
        opts.lifecycleHint === 'VERIFYING')
    ) {
      return opts.lifecycleHint;
    }
  }

  switch (status) {
    case 'Queued':
      return 'PENDING';
    case 'Preparing':
    case 'Creating Disk':
      return 'PREPARING';
    case 'Downloading Image':
      return 'DOWNLOADING_ISO';
    case 'Installing':
      if (opts?.isRebooting) return 'REBOOTING';
      if (opts?.rdpLocalConnected) return 'VERIFYING';
      return 'INSTALLING';
    case 'Booting':
      return opts?.isRebooting ? 'REBOOTING' : 'BOOTING';
    case 'Running':
      return opts?.isExternalVerified ? 'READY' : 'VERIFYING';
    case 'Ready':
    case 'Online':
      return 'READY';
    case 'Stopped':
      return 'STOPPED';
    case 'Failed':
      return 'ERROR';
    default:
      return 'PENDING';
  }
}

export function getLifecycleDisplayInfo(state: VmLifecycleState): {
  label: string;
  badgeColor: 'green' | 'blue' | 'amber' | 'red' | 'slate';
  isActive: boolean;
} {
  switch (state) {
    case 'READY':
      return { label: 'READY', badgeColor: 'green', isActive: true };
    case 'DOWNLOADING_ISO':
      return { label: 'DOWNLOADING_ISO', badgeColor: 'blue', isActive: true };
    case 'PREPARING':
      return { label: 'PREPARING', badgeColor: 'blue', isActive: true };
    case 'INSTALLING':
      return { label: 'INSTALLING', badgeColor: 'blue', isActive: true };
    case 'REBOOTING':
      return { label: 'REBOOTING', badgeColor: 'amber', isActive: true };
    case 'BOOTING':
      return { label: 'BOOTING', badgeColor: 'blue', isActive: true };
    case 'CONFIGURING_NETWORK':
      return { label: 'CONFIGURING_NETWORK', badgeColor: 'blue', isActive: true };
    case 'CONFIGURING_RDP':
      return { label: 'CONFIGURING_RDP', badgeColor: 'blue', isActive: true };
    case 'VERIFYING':
      return { label: 'VERIFYING', badgeColor: 'amber', isActive: true };
    case 'STOPPED':
      return { label: 'STOPPED', badgeColor: 'slate', isActive: false };
    case 'ERROR':
      return { label: 'ERROR', badgeColor: 'red', isActive: false };
    case 'PENDING':
    default:
      return { label: 'PENDING', badgeColor: 'amber', isActive: true };
  }
}

export function parseCgroupOomControl(raw: string): CgroupOomStats {
  const oomKillDisable = /oom_kill_disable\s+1\b/.test(raw);
  const underOom = /under_oom\s+1\b/.test(raw);
  const match = raw.match(/oom_kill\s+(\d+)/);
  const oomKillCount = match ? Number(match[1]) : 0;
  return {
    oomKillDisable,
    underOom,
    oomKillCount: Number.isFinite(oomKillCount) ? oomKillCount : 0,
  };
}

export function classifyQemuExitCause(params: {
  osName: string;
  exitCode: number | null;
  signal: string | null;
  stderrTail?: string;
  oomKillDelta?: number;
  underOom?: boolean;
  memAvailableMb?: number;
  requestedShutdown?: boolean;
}): QemuExitClassification {
  const stderr = (params.stderrTail || '').trim();
  const stderrLower = stderr.toLowerCase();
  const oomDelta = params.oomKillDelta || 0;
  const lowMem = typeof params.memAvailableMb === 'number' && params.memAvailableMb > 0 && params.memAvailableMb < 256;

  if (params.requestedShutdown && (params.exitCode === 0 || params.signal === 'SIGTERM' || params.signal === 'SIGKILL')) {
    return {
      oomDetected: false,
      causeCode: 'ACPI_SHUTDOWN',
      message: `${params.osName} VM stopped cleanly by administrator request.`,
    };
  }

  if (
    oomDelta > 0 ||
    params.underOom ||
    (params.signal === 'SIGKILL' && lowMem) ||
    stderrLower.includes('cannot allocate memory') ||
    stderrLower.includes('cannot set up guest memory') ||
    stderrLower.includes('out of memory')
  ) {
    return {
      oomDetected: true,
      causeCode: 'CONTAINER_OOM_KILL',
      message: `${params.osName} QEMU process was terminated due to container memory exhaustion / OOM (signal=${params.signal || 'none'}, exitCode=${params.exitCode ?? 'null'}, oomKills=+${oomDelta}, memAvail=${params.memAvailableMb ?? '?'} MiB).`,
      remediation:
        'Reduce concurrent VMs, delete cached ISOs in overlayfs RAM, or provision on a host with >= 16 GiB RAM for full Windows installation.',
    };
  }

  if (stderrLower.includes('no space left on device') || stderrLower.includes('enospc')) {
    return {
      oomDetected: false,
      causeCode: 'DISK_FULL',
      message: `${params.osName} QEMU process failed due to insufficient host disk space (ENOSPC).`,
      remediation: 'Free host storage or delete unused VM disks/ISOs before retrying.',
    };
  }

  if (stderrLower.includes('could not open') || stderrLower.includes('no such file')) {
    return {
      oomDetected: false,
      causeCode: 'MISSING_MEDIA',
      message: `${params.osName} QEMU process failed to open disk or ISO media: ${stderr.slice(-240)}`,
      remediation: 'Verify ISO and QCOW2 disk integrity before restarting.',
    };
  }

  if (params.signal) {
    const isSigkill = params.signal === 'SIGKILL';
    return {
      oomDetected: isSigkill && lowMem,
      causeCode: isSigkill ? 'HOST_MEMORY_EXHAUSTED' : 'SIGNAL_TERMINATED',
      message: `${params.osName} QEMU process terminated unexpectedly by signal ${params.signal}${stderr ? `: ${stderr.slice(-200)}` : '.'}`,
      remediation: isSigkill
        ? 'SIGKILL often indicates kernel/container OOM kill or external process termination. Check host memory headroom.'
        : undefined,
    };
  }

  if (params.exitCode === 0) {
    return {
      oomDetected: false,
      causeCode: 'ACPI_SHUTDOWN',
      message: `${params.osName} guest OS exited cleanly (code=0) before RDP verification completed.`,
    };
  }

  return {
    oomDetected: false,
    causeCode: 'QEMU_RUNTIME_ERROR',
    message: `${params.osName} QEMU process exited with code=${params.exitCode ?? 'unknown'}${stderr ? `: ${stderr.slice(-240)}` : ''}.`,
  };
}

export function calculateSafeVmMemoryBudget(input: VmMemoryBudgetInput): VmMemoryBudgetResult {
  const tenPercentReserve = Math.ceil(input.hostTotalMb * 0.1);
  const hostReserveMb =
    input.osId === 'windows-10'
      ? Math.max(tenPercentReserve, input.hostReserveMb ?? 0)
      : Math.max(1024, input.hostReserveMb ?? 1536);
  const otherActiveQemuMb = Math.max(0, input.otherActiveQemuMb ?? 0);

  if (input.osId === 'debian-12') {
    const allocatedMemoryMb = Math.min(input.requestedMemoryMb || 2048, Math.max(512, input.hostTotalMb - hostReserveMb));
    return {
      allowed: true,
      allocatedMemoryMb,
      requestedMemoryMb: input.requestedMemoryMb,
      adjusted: allocatedMemoryMb !== input.requestedMemoryMb,
      hostReserveMb,
      qemuOverheadMb: 0,
      expectedDiskGrowthMb: 0,
      estimatedTotalFootprintMb: allocatedMemoryMb,
      headroomAfterMb: Math.max(0, input.hostAvailableMb),
    };
  }

  const isWin7 = input.osId === 'windows-7';
  const minGuestMb = isWin7 ? 768 : 2048;
  const maxAllVmsMemoryMb = Math.max(0, Math.floor(input.hostTotalMb * 0.9));
  const effectiveReserveMb = isWin7 ? hostReserveMb : Math.max(tenPercentReserve, input.hostTotalMb - maxAllVmsMemoryMb);
  const maxConfiguredMb = isWin7
    ? input.win7MaxRamMb || (input.isMemoryBackedOverlay && input.hostTotalMb <= 14336 ? 1024 : 2048)
    : input.win10MaxRamMb || Math.max(4096, maxAllVmsMemoryMb);

  const hardPercentCapMb = isWin7
    ? Math.max(minGuestMb, Math.floor(input.hostTotalMb * 0.5))
    : Math.max(minGuestMb, maxAllVmsMemoryMb);
  let targetGuestMb = Math.min(
    Math.max(minGuestMb, input.requestedMemoryMb || (isWin7 ? 1024 : 4096)),
    maxConfiguredMb,
    hardPercentCapMb
  );

  // QEMU TCG overhead: code translation cache + QEMU heap + VGA + NBD buffer cache
  const qemuOverheadMb = isWin7 ? 320 : 448;

  // On RAM-backed overlayfs, Windows 7 installer expansion consumes container RAM;
  // Windows 10 uses the 90% ceiling + real MemAvailable minus 10% host reserve directly.
  const expectedFinalDiskMb = 5600;
  const expectedDiskGrowthMb = isWin7
    ? input.isMemoryBackedOverlay && input.attachInstallerIso
      ? Math.max(0, expectedFinalDiskMb - Math.max(0, input.existingDiskMb))
      : input.isMemoryBackedOverlay
      ? 256
      : 0
    : input.isMemoryBackedOverlay
    ? 256
    : 0;

  // Check multi-VM overcommit against maxAllVmsMemoryMb (90% rule for win10, hostTotal - hostReserve for win7)
  const vmCeilingMb = isWin7 ? Math.max(0, input.hostTotalMb - hostReserveMb) : maxAllVmsMemoryMb;
  if (otherActiveQemuMb + minGuestMb > vmCeilingMb) {
    return {
      allowed: false,
      code: 'OVERCOMMIT_PREVENTED',
      allocatedMemoryMb: 0,
      requestedMemoryMb: input.requestedMemoryMb,
      adjusted: false,
      hostReserveMb: effectiveReserveMb,
      qemuOverheadMb,
      expectedDiskGrowthMb,
      estimatedTotalFootprintMb: otherActiveQemuMb + minGuestMb + qemuOverheadMb,
      headroomAfterMb: input.hostAvailableMb - (minGuestMb + qemuOverheadMb),
      reason: `Prevented host RAM overcommit: other running VMs already allocate ${otherActiveQemuMb} MiB out of ${vmCeilingMb} MiB guest ceiling (${effectiveReserveMb} MiB reserved for host/API).`,
      remediation: 'Stop or delete other running VMs before launching a new guest.',
    };
  }

  // Never allocate more than remaining 90% quota
  if (otherActiveQemuMb + targetGuestMb > vmCeilingMb) {
    if (isWin7) {
      targetGuestMb = Math.max(minGuestMb, vmCeilingMb - otherActiveQemuMb);
    } else {
      return {
        allowed: false,
        code: 'OVERCOMMIT_PREVENTED',
        allocatedMemoryMb: 0,
        requestedMemoryMb: input.requestedMemoryMb,
        adjusted: false,
        hostReserveMb: effectiveReserveMb,
        qemuOverheadMb,
        expectedDiskGrowthMb,
        estimatedTotalFootprintMb: otherActiveQemuMb + targetGuestMb + qemuOverheadMb,
        headroomAfterMb: input.hostAvailableMb - (targetGuestMb + qemuOverheadMb),
        reason: `Vượt giới hạn 90% RAM cho phép (${vmCeilingMb} MiB / ${input.hostTotalMb} MiB, giữ lại ${effectiveReserveMb} MiB [10%]). Các VM khác đang dùng ${otherActiveQemuMb} MiB, không đủ cấp ${targetGuestMb} MiB.`,
        remediation: 'Giảm RAM cấu hình hoặc tắt bớt máy ảo đang chạy.',
      };
    }
  }

  // Fit within currently available container RAM while reserving >= 10% host buffer
  const safetyBufferMb = isWin7 ? 512 : Math.max(512, effectiveReserveMb);
  const maxSafeByAvailMb = input.hostAvailableMb - qemuOverheadMb - safetyBufferMb;
  if (input.hostAvailableMb > 0 && targetGuestMb > maxSafeByAvailMb) {
    if (isWin7) {
      targetGuestMb = Math.floor(maxSafeByAvailMb / 128) * 128;
    } else {
      return {
        allowed: false,
        code: 'INSUFFICIENT_HOST_MEMORY',
        allocatedMemoryMb: 0,
        requestedMemoryMb: input.requestedMemoryMb,
        adjusted: false,
        hostReserveMb: effectiveReserveMb,
        qemuOverheadMb,
        expectedDiskGrowthMb,
        estimatedTotalFootprintMb: targetGuestMb + qemuOverheadMb + safetyBufferMb,
        headroomAfterMb: input.hostAvailableMb - (targetGuestMb + qemuOverheadMb),
        reason: `Không đủ RAM khả dụng để cấp ${targetGuestMb} MiB cho ${input.osId} mà vẫn chừa >= 10% (${effectiveReserveMb} MiB) cho máy chủ (MemAvailable=${input.hostAvailableMb} MiB).`,
        remediation: 'Tắt bớt máy ảo đang chạy hoặc giảm dung lượng RAM yêu cầu.',
      };
    }
  }

  if (targetGuestMb < minGuestMb) {
    const needMb = minGuestMb + qemuOverheadMb + safetyBufferMb;
    return {
      allowed: false,
      code: 'INSUFFICIENT_HOST_MEMORY',
      allocatedMemoryMb: 0,
      requestedMemoryMb: input.requestedMemoryMb,
      adjusted: false,
      hostReserveMb: effectiveReserveMb,
      qemuOverheadMb,
      expectedDiskGrowthMb,
      estimatedTotalFootprintMb: needMb,
      headroomAfterMb: input.hostAvailableMb - needMb,
      reason: `Insufficient available container memory for ${input.osId}: available=${input.hostAvailableMb} MiB, minimum safe requirement=${needMb} MiB (${minGuestMb} MiB guest + ${qemuOverheadMb} MiB hypervisor + ${safetyBufferMb} MiB host buffer).`,
      remediation: 'Stop other VMs or remove cached local ISO files before starting installation.',
    };
  }

  const runtimeNeededMb = targetGuestMb + qemuOverheadMb;
  const totalWithDiskGrowthMb = runtimeNeededMb + expectedDiskGrowthMb;
  const headroomAfterMb = input.hostAvailableMb - totalWithDiskGrowthMb;

  if (isWin7 && input.isMemoryBackedOverlay && input.attachInstallerIso && input.hostAvailableMb > 0 && headroomAfterMb < 256) {
    return {
      allowed: false,
      code: 'INSUFFICIENT_HOST_MEMORY',
      allocatedMemoryMb: targetGuestMb,
      requestedMemoryMb: input.requestedMemoryMb,
      adjusted: targetGuestMb !== input.requestedMemoryMb,
      hostReserveMb: effectiveReserveMb,
      qemuOverheadMb,
      expectedDiskGrowthMb,
      estimatedTotalFootprintMb: totalWithDiskGrowthMb,
      headroomAfterMb,
      reason: `Insufficient RAM on memory-backed container overlayfs for full ${input.osId} installation: MemAvailable=${input.hostAvailableMb} MiB, estimated footprint=${totalWithDiskGrowthMb} MiB (guest=${targetGuestMb} MiB + QEMU=${qemuOverheadMb} MiB + QCOW2 expansion=${expectedDiskGrowthMb} MiB).`,
      remediation:
        'Reclaim overlayfs RAM (remove cached local ISOs / unused files, use NBD ISO streaming) or run on a host with >= 16 GiB RAM or disk-backed storage.',
    };
  }

  return {
    allowed: true,
    allocatedMemoryMb: targetGuestMb,
    requestedMemoryMb: input.requestedMemoryMb,
    adjusted: targetGuestMb !== input.requestedMemoryMb,
    hostReserveMb: effectiveReserveMb,
    qemuOverheadMb,
    expectedDiskGrowthMb,
    estimatedTotalFootprintMb: totalWithDiskGrowthMb,
    headroomAfterMb,
  };
}

export function evaluateIsoChecksum(
  actualSha256: string | null | undefined,
  expectedSha256: string | null | undefined
): IsoChecksumEvaluation {
  const expected = (expectedSha256 || '').trim().toLowerCase();
  const actual = (actualSha256 || '').trim().toLowerCase();
  if (!expected) {
    return {
      verified: false,
      status: 'UNAVAILABLE',
      reason: 'No reference SHA-256 checksum defined for this image.',
    };
  }
  if (!actual || !/^[a-f0-9]{64}$/.test(actual)) {
    return {
      verified: false,
      status: 'MISMATCH',
      reason: 'Computed SHA-256 digest is missing or malformed.',
    };
  }
  if (actual !== expected) {
    return {
      verified: false,
      status: 'MISMATCH',
      reason: `SHA-256 mismatch: expected ${expected}, got ${actual}.`,
    };
  }
  return {
    verified: true,
    status: 'VERIFIED',
  };
}

export type DeploymentStageKey =
  | 'checking_environment'
  | 'downloading_iso'
  | 'verifying_iso'
  | 'extracting_files'
  | 'preparing_installer'
  | 'installing_windows'
  | 'configuring_windows'
  | 'starting_windows'
  | 'ready'
  | 'failed';

export interface DeploymentStageItem {
  key: DeploymentStageKey;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  detail?: string;
}

export interface IsoDownloadProgress {
  status: 'idle' | 'downloading' | 'verifying' | 'cached' | 'failed';
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  provider?: string;
  cachedReused?: boolean;
  checksumVerified?: boolean;
}

export function calculateDeploymentOverallPercent(
  stages: DeploymentStageItem[],
  isoProgress?: IsoDownloadProgress
): number {
  if (!stages || stages.length === 0) return 0;
  let score = 0;
  for (const s of stages) {
    if (s.status === 'completed' || s.status === 'skipped') score += 1;
    else if (s.status === 'active') {
      if (s.key === 'downloading_iso' && isoProgress && isoProgress.percent > 0) {
        score += Math.min(0.95, isoProgress.percent / 100);
      } else {
        score += 0.5;
      }
    }
  }
  return Math.min(100, Math.round((score / stages.length) * 100));
}
