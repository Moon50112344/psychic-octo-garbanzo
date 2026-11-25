import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { serverLogger } from './logger';
import { resolvePersistentStorageRoot } from './storagePath';
import { resolveOvmfPaths } from './infrastructure';
import { getAvailableDiskBytes, isMemoryBackedOverlayfs } from './dockurEngine';
import { generateWindowsPassword } from '../utils/credentials';
import { buildWindowsAutounattendXml, resolvePreferredWimImageIndex } from './winAutounattend';
import { hypervisor } from './hypervisor';
import { buildKeyComboEvents, getWindowsIsoBootKeySchedule } from './qmpInput';

export type Win10BasePreinstallStatus =
  | 'NOT_STARTED'
  | 'INSTALLING_BASE'
  | 'READY'
  | 'SKIPPED_OVERLAY_RAM_LIMIT'
  | 'SKIPPED_LOW_DISK'
  | 'FAILED';

export interface Win10BasePreinstallState {
  status: Win10BasePreinstallStatus;
  ready: boolean;
  baseDiskPath: string;
  ovmfVarsPath: string;
  sizeBytes: number;
  message: string;
  hypervisorMode: 'kvm' | 'tcg';
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type BaseBuildEligibilityResult =
  | { eligible: true; reason: string }
  | {
      eligible: false;
      code:
        | 'ALREADY_READY'
        | 'WAIT_FOR_ISO'
        | 'SKIPPED_OVERLAY_RAM_LIMIT'
        | 'SKIPPED_LOW_DISK'
        | 'SKIPPED_MISSING_TOOLS'
        | 'DEFERRED_RESOURCES';
      reason: string;
    };

const MIN_VALID_WIN10_QCOW2_BYTES = 1200 * 1024 * 1024;
const MIN_FREE_DISK_BYTES_FOR_BASE = 18 * 1024 * 1024 * 1024;
const BUILD_GUEST_RAM_MB = 4096;

export function evaluateWin10BaseBuildEligibility(params: {
  alreadyExists: boolean;
  installerReady: boolean;
  isMemoryBackedOverlay: boolean;
  hostTotalMb: number;
  freeDiskBytes: number;
  hasQemu: boolean;
  hasOvmf: boolean;
  hasGenisoimage: boolean;
  ramAllowed: boolean;
  cpuThrottled: boolean;
}): BaseBuildEligibilityResult {
  if (params.alreadyExists) {
    return { eligible: false, code: 'ALREADY_READY', reason: 'windows-10-base.qcow2 đã sẵn sàng trên đĩa.' };
  }
  if (!params.installerReady) {
    return { eligible: false, code: 'WAIT_FOR_ISO', reason: 'Đang chờ bộ cài Windows 10 ISO sẵn sàng (READY).' };
  }
  if (params.isMemoryBackedOverlay && params.hostTotalMb < 20 * 1024) {
    return {
      eligible: false,
      code: 'SKIPPED_OVERLAY_RAM_LIMIT',
      reason: `Môi trường RAM-backed overlayfs (${Math.round(params.hostTotalMb / 1024)} GiB RAM) không thể chứa đồng thời ISO 4.6 GiB + base QCOW2 ~6 GiB + QEMU 4 GiB trong RAM; chạy cài đặt trực tiếp từ ISO đã chuẩn bị.`,
    };
  }
  if (params.freeDiskBytes > 0 && params.freeDiskBytes < MIN_FREE_DISK_BYTES_FOR_BASE) {
    return {
      eligible: false,
      code: 'SKIPPED_LOW_DISK',
      reason: `Dung lượng ổ đĩa trống (${(params.freeDiskBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB) dưới mức khuyến nghị 18 GiB để pre-install base disk.`,
    };
  }
  if (!params.hasQemu || !params.hasOvmf || !params.hasGenisoimage) {
    return {
      eligible: false,
      code: 'SKIPPED_MISSING_TOOLS',
      reason: 'Thiếu công cụ qemu-system-x86_64 / OVMF / genisoimage để pre-install Windows 10 base disk.',
    };
  }
  if (!params.ramAllowed || params.cpuThrottled) {
    return {
      eligible: false,
      code: 'DEFERRED_RESOURCES',
      reason: 'Tài nguyên RAM (>90%) hoặc CPU (>=95%) đang bận — hoãn pre-install nền để bảo vệ dịch vụ hiện có.',
    };
  }
  return { eligible: true, reason: 'Đủ điều kiện pre-install Windows 10 base disk tự động.' };
}

function validateQcow2File(diskPath: string): { valid: boolean; sizeBytes: number } {
  try {
    if (!fs.existsSync(diskPath)) return { valid: false, sizeBytes: 0 };
    const stat = fs.statSync(diskPath);
    if (stat.size < MIN_VALID_WIN10_QCOW2_BYTES) return { valid: false, sizeBytes: stat.size };
    const fd = fs.openSync(diskPath, 'r');
    const hdr = Buffer.alloc(4);
    fs.readSync(fd, hdr, 0, 4, 0);
    fs.closeSync(fd);
    return { valid: hdr.toString('ascii', 0, 3) === 'QFI', sizeBytes: stat.size };
  } catch {
    return { valid: false, sizeBytes: 0 };
  }
}

export class Win10BasePreinstaller {
  private dataDir: string;
  private disksDir: string;
  private baseDiskPath: string;
  private baseVarsPath: string;
  private lockPath: string;
  private state: Win10BasePreinstallState;
  private activePromise: Promise<Win10BasePreinstallState> | null = null;
  private activeQemuProc: ChildProcess | null = null;

  constructor(options?: { rootDir?: string }) {
    const storageLoc = resolvePersistentStorageRoot(
      options?.rootDir ? { workspaceRoot: options.rootDir } : undefined
    );
    this.dataDir = storageLoc.dataDir;
    this.disksDir = path.join(this.dataDir, 'disks');
    this.baseDiskPath = path.join(this.disksDir, 'windows-10-base.qcow2');
    this.baseVarsPath = path.join(this.disksDir, 'windows-10-base-OVMF_VARS.fd');
    this.lockPath = path.join(this.disksDir, '.win10-base-build.lock');

    try {
      fs.mkdirSync(this.disksDir, { recursive: true });
    } catch {
      // ignore
    }

    const existing = validateQcow2File(this.baseDiskPath);
    const hasKvm = fs.existsSync('/dev/kvm');
    this.state = {
      status: existing.valid ? 'READY' : 'NOT_STARTED',
      ready: existing.valid,
      baseDiskPath: this.baseDiskPath,
      ovmfVarsPath: this.baseVarsPath,
      sizeBytes: existing.sizeBytes,
      hypervisorMode: hasKvm ? 'kvm' : 'tcg',
      message: existing.valid
        ? `Windows 10 base image đã cài sẵn (${(existing.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB QCOW2) — tạo máy clone tức thì như Debian 12.`
        : 'Chưa có Windows 10 pre-installed base QCOW2; kiểm tra điều kiện hệ thống khi khởi động.',
    };
  }

  public getState(): Win10BasePreinstallState {
    const existing = validateQcow2File(this.baseDiskPath);
    if (existing.valid && !this.state.ready) {
      this.state = {
        ...this.state,
        status: 'READY',
        ready: true,
        sizeBytes: existing.sizeBytes,
        message: `Windows 10 base image đã cài sẵn (${(existing.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB QCOW2) — tạo máy clone tức thì.`,
      };
    }
    return { ...this.state };
  }

  public getActiveMemoryMb(): number {
    return this.activeQemuProc && this.activeQemuProc.exitCode === null ? BUILD_GUEST_RAM_MB : 0;
  }

  public async runStartupPreinstallIfEligible(params: {
    isoPath: string;
    wimIndex?: number;
    ramAllowed: boolean;
    cpuThrottled: boolean;
    timeoutMs?: number;
  }): Promise<Win10BasePreinstallState> {
    if (this.activePromise) {
      return this.activePromise;
    }

    this.activePromise = this.runBuildInternal(params).finally(() => {
      this.activePromise = null;
    });
    return this.activePromise;
  }

  private async runBuildInternal(params: {
    isoPath: string;
    wimIndex?: number;
    ramAllowed: boolean;
    cpuThrottled: boolean;
    timeoutMs?: number;
  }): Promise<Win10BasePreinstallState> {
    const existing = validateQcow2File(this.baseDiskPath);
    const ovmf = resolveOvmfPaths();
    const genisoBin = fs.existsSync('/usr/bin/genisoimage')
      ? '/usr/bin/genisoimage'
      : fs.existsSync('/usr/bin/mkisofs')
      ? '/usr/bin/mkisofs'
      : null;

    const eligibility = evaluateWin10BaseBuildEligibility({
      alreadyExists: existing.valid,
      installerReady: Boolean(params.isoPath && fs.existsSync(params.isoPath)),
      isMemoryBackedOverlay: isMemoryBackedOverlayfs(),
      hostTotalMb: Math.floor(os.totalmem() / (1024 * 1024)),
      freeDiskBytes: getAvailableDiskBytes(this.disksDir),
      hasQemu: fs.existsSync('/usr/bin/qemu-system-x86_64') && fs.existsSync('/usr/bin/qemu-img'),
      hasOvmf: Boolean(ovmf.codePath && ovmf.varsPath),
      hasGenisoimage: Boolean(genisoBin),
      ramAllowed: params.ramAllowed,
      cpuThrottled: params.cpuThrottled,
    });

    if (!eligibility.eligible) {
      if (eligibility.code === 'ALREADY_READY') {
        this.state = {
          ...this.state,
          status: 'READY',
          ready: true,
          sizeBytes: existing.sizeBytes,
          message: eligibility.reason,
        };
      } else if (eligibility.code === 'SKIPPED_OVERLAY_RAM_LIMIT') {
        this.state = {
          ...this.state,
          status: 'SKIPPED_OVERLAY_RAM_LIMIT',
          ready: false,
          message: eligibility.reason,
        };
        serverLogger.info('Win10BaseBuild', eligibility.reason);
      } else if (eligibility.code === 'SKIPPED_LOW_DISK') {
        this.state = {
          ...this.state,
          status: 'SKIPPED_LOW_DISK',
          ready: false,
          message: eligibility.reason,
        };
        serverLogger.warn('Win10BaseBuild', eligibility.reason);
      }
      return this.getState();
    }

    if (fs.existsSync(this.lockPath)) {
      return this.getState();
    }

    fs.mkdirSync(this.disksDir, { recursive: true });
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');

    const buildDisk = `${this.baseDiskPath}.building`;
    const buildVars = `${this.baseVarsPath}.building`;
    const buildDir = path.join(this.dataDir, 'provisioning', '_win10-base-build');
    const tpmDir = path.join(this.dataDir, 'tpm', '_win10-base-build');
    const qmpSock = '/tmp/qmp-win10-base-build.sock';

    let swtpmProc: ChildProcess | null = null;

    try {
      fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(tpmDir, { recursive: true, mode: 0o700 });
      for (const f of [buildDisk, buildVars, qmpSock]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }

      const hasKvm = fs.existsSync('/dev/kvm');
      this.state = {
        ...this.state,
        status: 'INSTALLING_BASE',
        ready: false,
        hypervisorMode: hasKvm ? 'kvm' : 'tcg',
        startedAt: new Date().toISOString(),
        message: `Đang tự động cài sẵn Windows 10 base image (windows-10-base.qcow2) trong container startup (${hasKvm ? 'KVM' : 'QEMU TCG'})...`,
      };
      serverLogger.info('Win10BaseBuild', this.state.message);

      execFileSync('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-o', 'compression_type=zstd,cluster_size=65536', buildDisk, '40G'], {
        stdio: 'pipe',
      });
      fs.copyFileSync(ovmf.varsPath!, buildVars);

      const buildPwd = generateWindowsPassword(16);
      const wimIndex = params.wimIndex || resolvePreferredWimImageIndex(params.isoPath, 'windows-10');
      const unattendXml = buildWindowsAutounattendXml({
        osId: 'windows-10',
        username: 'Administrator',
        password: buildPwd,
        computerName: 'MOONWIN10BASE',
        wimIndex,
        installCredSyncTask: true,
        shutdownAfterFirstLogon: true,
      });
      const xmlPath = path.join(buildDir, 'Autounattend.xml');
      const unattendIso = path.join(buildDir, 'Autounattend.iso');
      fs.writeFileSync(xmlPath, unattendXml, { encoding: 'utf8', mode: 0o600 });
      execFileSync(genisoBin!, ['-J', '-R', '-V', 'UNATTEND', '-o', unattendIso, xmlPath], { stdio: 'pipe' });

      const swtpmSock = path.join(tpmDir, 'swtpm-sock');
      if (fs.existsSync('/usr/bin/swtpm')) {
        if (fs.existsSync(swtpmSock)) fs.unlinkSync(swtpmSock);
        swtpmProc = spawn('/usr/bin/swtpm', ['socket', '--tpmstate', `dir=${tpmDir}`, '--ctrl', `type=unixio,path=${swtpmSock}`, '--tpm2', '--log', 'level=0'], {
          stdio: 'ignore',
        });
        await new Promise((r) => setTimeout(r, 400));
      }

      const cores = Math.max(2, Math.min(4, os.cpus().length));
      const accel = hasKvm ? 'kvm' : cores > 1 ? 'tcg,thread=multi,tb-size=64' : 'tcg,tb-size=64';
      const cpuArg = hasKvm ? 'host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time' : 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt';

      const qemuArgs = [
        '-machine', 'q35',
        '-accel', accel,
        '-cpu', cpuArg,
        '-m', `${BUILD_GUEST_RAM_MB}M`,
        '-smp', `${cores}`,
        '-drive', `if=pflash,format=raw,readonly=on,file=${ovmf.codePath!}`,
        '-drive', `if=pflash,format=raw,file=${buildVars}`,
      ];
      if (swtpmProc && fs.existsSync(swtpmSock)) {
        qemuArgs.push(
          '-chardev', `socket,id=chrtpm,path=${swtpmSock}`,
          '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
          '-device', 'tpm-tis,tpmdev=tpm0'
        );
      }
      qemuArgs.push(
        '-device', 'ahci,id=ahci',
        '-blockdev', `node-name=disk0-file,driver=file,filename=${buildDisk},aio=threads`,
        '-blockdev', 'node-name=disk0-qcow2,driver=qcow2,file=disk0-file,discard=unmap,detect-zeroes=unmap',
        '-device', 'ide-hd,drive=disk0-qcow2,bus=ahci.0,bootindex=2',
        '-drive', `id=cdrom0,file=${params.isoPath},format=raw,media=cdrom,readonly=on,if=none`,
        '-device', 'ide-cd,drive=cdrom0,bus=ahci.1,bootindex=1',
        '-drive', `id=cdrom1,file=${unattendIso},media=cdrom,readonly=on,if=none`,
        '-device', 'ide-cd,drive=cdrom1,bus=ahci.2',
        '-netdev', 'user,id=net0',
        '-device', 'e1000e,netdev=net0',
        '-vga', 'std',
        '-device', 'usb-ehci,id=ehci',
        '-device', 'usb-tablet',
        '-rtc', 'base=localtime,clock=host',
        '-qmp', `unix:${qmpSock},server,nowait`,
        '-display', 'none'
      );

      const timeoutMs = params.timeoutMs || 150 * 60 * 1000;
      const bootTimers: NodeJS.Timeout[] = [];
      const clearBootTimers = () => {
        while (bootTimers.length > 0) {
          const t = bootTimers.pop();
          if (t) clearTimeout(t);
        }
      };

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('/usr/bin/qemu-system-x86_64', qemuArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
        this.activeQemuProc = proc;
        let errTail = '';
        proc.stderr?.on('data', (d) => {
          errTail = `${errTail}${d.toString()}`.slice(-800);
        });

        const schedule = getWindowsIsoBootKeySchedule({
          osId: 'windows-10',
          attachInstallerIso: true,
          diskHasBootableOs: false,
        });
        const events = buildKeyComboEvents(schedule.keys);
        for (const delayMs of schedule.delaysMs) {
          const bt = setTimeout(() => {
            if (proc.exitCode === null && fs.existsSync(qmpSock) && events.length > 0) {
              void hypervisor.sendQmpCommand(qmpSock, 'input-send-event', { events }).catch(() => undefined);
            }
          }, delayMs);
          bt.unref?.();
          bootTimers.push(bt);
        }

        const timer = setTimeout(() => {
          clearBootTimers();
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
          reject(new Error(`Win10 base pre-install timed out after ${Math.round(timeoutMs / 60000)}m`));
        }, timeoutMs);
        proc.on('error', (err) => {
          clearBootTimers();
          clearTimeout(timer);
          reject(err);
        });
        proc.on('close', (code) => {
          clearBootTimers();
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`QEMU base install exited with code ${code}: ${errTail.trim()}`));
        });
      });

      const check = validateQcow2File(buildDisk);
      if (!check.valid) {
        throw new Error(`Windows 10 base QCOW2 validation failed after install (size=${check.sizeBytes} B).`);
      }

      fs.renameSync(buildDisk, this.baseDiskPath);
      fs.renameSync(buildVars, this.baseVarsPath);

      this.state = {
        ...this.state,
        status: 'READY',
        ready: true,
        sizeBytes: check.sizeBytes,
        completedAt: new Date().toISOString(),
        message: `Windows 10 base image đã cài hoàn tất (${(check.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB QCOW2) — sẵn sàng clone tức thì như Debian 12.`,
      };
      serverLogger.info('Win10BaseBuild', this.state.message);
      return this.getState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        status: 'FAILED',
        ready: false,
        error: msg,
        message: `Pre-install Windows 10 base disk thất bại: ${msg}`,
      };
      serverLogger.error('Win10BaseBuild', msg);
      return this.getState();
    } finally {
      this.activeQemuProc = null;
      if (swtpmProc) {
        try {
          swtpmProc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      for (const cleanup of [buildDisk, buildVars, qmpSock, this.lockPath]) {
        try {
          if (fs.existsSync(cleanup)) fs.unlinkSync(cleanup);
        } catch {
          // ignore
        }
      }
    }
  }
}

export const win10BasePreinstaller = new Win10BasePreinstaller();
