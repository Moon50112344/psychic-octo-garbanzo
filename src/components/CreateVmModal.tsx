import React, { useState, useEffect, useCallback } from 'react';
import { X, Plus, Cpu, HardDrive, Layers, AlertTriangle, ShieldCheck, RefreshCw, Download, Trash2, CheckCircle2, Network, Monitor } from 'lucide-react';
import { OsSelector } from './OsSelector';
import { SupportedOsId, OsDefinition } from '../server/imageManager';
import type { Win10DeployState } from '../server/win10DeployManager';
import type { Win10BasePreinstallState } from '../server/win10BasePreinstaller';
import type { HostResourceSnapshot } from '../server/resourceManager';

interface ImagePreflightItem {
  osId: SupportedOsId;
  status: string;
  mediaState?: string;
  filePath?: string;
  exists?: boolean;
  sizeBytes?: number;
  expectedSizeBytes?: number;
  progressPercent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  autoDownloadAvailable?: boolean;
  dockurVersion?: string;
  sourceLabel?: string;
  checksumVerified?: boolean;
  checksumStatus?: 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED' | 'MISSING';
  sha256Expected?: string;
  sha256Actual?: string;
  verifiedAt?: string;
  error?: string;
  remediation?: string;
  autoRetryScheduled?: boolean;
  retryCount?: number;
  nextRetryAt?: string;
}

interface CreateVmModalProps {
  isOpen: boolean;
  onClose: () => void;
  osList: OsDefinition[];
  initialOs?: SupportedOsId;
  onVmCreated: (vm: any) => void;
}

export function CreateVmModal({ isOpen, onClose, osList, initialOs, onVmCreated }: CreateVmModalProps) {
  const [selectedOs, setSelectedOs] = useState<SupportedOsId>(initialOs || 'debian-12');
  const [vmName, setVmName] = useState<string>('');
  const [cores, setCores] = useState<number>(2);
  const [memoryMb, setMemoryMb] = useState<number>(initialOs === 'windows-10' ? 4096 : initialOs === 'windows-7' ? 1024 : 2048);
  const [diskGb, setDiskGb] = useState<number>(initialOs === 'windows-10' ? 64 : 40);
  const [networkModel, setNetworkModel] = useState<'e1000e' | 'virtio'>('e1000e');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isoActionBusy, setIsoActionBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [imageStatuses, setImageStatuses] = useState<Record<string, ImagePreflightItem>>({});
  const [win10Installer, setWin10Installer] = useState<Win10DeployState | null>(null);
  const [win10BaseImage, setWin10BaseImage] = useState<Win10BasePreinstallState | null>(null);
  const [hostResources, setHostResources] = useState<HostResourceSnapshot | null>(null);
  const [kvmAvailable, setKvmAvailable] = useState<boolean | null>(null);
  const [hostMemInfo, setHostMemInfo] = useState<{ total: string; available: string } | null>(null);

  const fetchImages = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/images');
      if (!res.ok) return;
      const imgJson = await res.json();
      if (imgJson?.success && Array.isArray(imgJson.images)) {
        const map: Record<string, ImagePreflightItem> = {};
        for (const item of imgJson.images) {
          map[item.osId] = item;
        }
        setImageStatuses(map);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchWin10Status = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/win10-installer/status');
      if (!res.ok) return;
      const json = await res.json();
      if (json?.success && json.installer) {
        setWin10Installer(json.installer);
      }
      if (json?.success && json.baseImage) {
        setWin10BaseImage(json.baseImage);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchHostResources = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/resources');
      if (!res.ok) return;
      const json = await res.json();
      if (json?.success && json.resources) {
        setHostResources(json.resources);
      }
    } catch {
      // ignore
    }
  }, []);

  const applyOsDefaults = (osId: SupportedOsId) => {
    setSelectedOs(osId);
    setError(null);
    const osDef = osList.find((o) => o.id === osId);
    if (osId === 'windows-10') {
      setCores(osDef?.recommendedCores || 2);
      setMemoryMb(osDef?.recommendedRamMb || 4096);
      setDiskGb(Math.max(64, osDef?.minDiskGb || 64));
      setNetworkModel('e1000e');
    } else if (osId === 'windows-7') {
      setCores(2);
      setMemoryMb(1024);
      setDiskGb(Math.max(40, osDef?.minDiskGb || 40));
    } else if (osDef) {
      setCores(osDef.recommendedCores || 2);
      setMemoryMb(osDef.recommendedRamMb || 2048);
      setDiskGb(Math.max(40, osDef.minDiskGb || 40));
    } else {
      setCores(2);
      setMemoryMb(2048);
      setDiskGb(40);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    applyOsDefaults(initialOs || 'debian-12');

    void fetchImages();
    void fetchWin10Status();
    void fetchHostResources();
    fetch('/api/v1/infra')
      .then((r) => (r.ok ? r.json() : null))
      .then((infraJson) => {
        if (infraJson?.success && infraJson.report?.virtualization) {
          setKvmAvailable(Boolean(infraJson.report.virtualization.kvmAvailable));
        }
        if (infraJson?.success && infraJson.report?.memory) {
          setHostMemInfo({
            total: infraJson.report.memory.totalFormatted,
            available: infraJson.report.memory.availableFormatted,
          });
        }
      })
      .catch(() => null);
  }, [isOpen, initialOs, fetchImages, fetchWin10Status, fetchHostResources]);

  const selectedMedia = imageStatuses[selectedOs];
  const isDownloadingOrVerifying =
    selectedMedia?.status === 'DOWNLOADING' || selectedMedia?.status === 'VERIFYING';
  const shouldPollSelectedMedia =
    isDownloadingOrVerifying ||
    Boolean(selectedMedia?.status === 'ERROR' && selectedMedia?.autoRetryScheduled);
  const isWin10Preparing =
    selectedOs === 'windows-10' &&
    (!win10Installer ||
      (win10Installer.status !== 'READY' && win10Installer.status !== 'FAILED') ||
      win10BaseImage?.status === 'INSTALLING_BASE');
  const shouldPollWin10 =
    selectedOs === 'windows-10' &&
    (!win10Installer ||
      win10Installer.status !== 'READY' ||
      win10BaseImage?.status === 'INSTALLING_BASE');

  useEffect(() => {
    if (!isOpen || (!shouldPollSelectedMedia && !shouldPollWin10)) return;
    const timer = setInterval(() => {
      if (shouldPollSelectedMedia) void fetchImages();
      if (shouldPollWin10) void fetchWin10Status();
      void fetchHostResources();
    }, 2000);
    return () => clearInterval(timer);
  }, [isOpen, shouldPollSelectedMedia, shouldPollWin10, fetchImages, fetchWin10Status, fetchHostResources]);

  if (!isOpen) return null;

  const handleSelectOs = (osId: SupportedOsId) => {
    applyOsDefaults(osId);
  };

  const handleIsoAction = async (action: 'download' | 'abort' | 'verify' | 'delete') => {
    if (selectedOs === 'windows-10') return;
    setIsoActionBusy(true);
    setError(null);
    try {
      const url = action === 'delete' ? `/api/v1/images/${selectedOs}` : `/api/v1/images/${selectedOs}/${action}`;
      const res = await fetch(url, { method: action === 'delete' ? 'DELETE' : 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && json.error) {
        setError(json.error);
      }
      await fetchImages();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsoActionBusy(false);
    }
  };

  const isWindows7 = selectedOs === 'windows-7';
  const isWindows10 = selectedOs === 'windows-10';
  const isWin10NotReady = isWindows10 && win10Installer?.status !== 'READY';
  const isCpuBlocked = Boolean(hostResources?.cpu.throttled);
  const isRamBlocked = Boolean(hostResources && memoryMb > hostResources.ram.availableForVmMb);
  const isMediaBlocked = isWin10NotReady || isCpuBlocked || isRamBlocked;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMediaBlocked) return;
    setIsSubmitting(true);
    setError(null);

    const targetDef = osList.find((o) => o.id === selectedOs);
    const finalName = vmName.trim() || `Cloud VPS (${targetDef?.name || selectedOs})`;

    try {
      const res = await fetch('/api/v1/vms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          osId: selectedOs,
          name: finalName,
          cores,
          memoryMb,
          diskGb,
          networkModel: isWindows10 ? networkModel : undefined,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        onVmCreated(json.vm);
        onClose();
      } else {
        throw new Error(json.error || 'Không thể tạo máy ảo mới.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const dlMb = ((selectedMedia?.downloadedBytes || 0) / (1024 * 1024)).toFixed(0);
  const totalMb = ((selectedMedia?.totalBytes || selectedMedia?.expectedSizeBytes || 0) / (1024 * 1024)).toFixed(0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85">
      <div className="bg-[#0d1424] border border-[#1e2a44] rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#1e2a44] flex items-center justify-between bg-[#0a101d]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-[#2f8bff]/10 border border-[#2f8bff]/30 text-[#2f8bff]">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Tạo máy ảo Cloud VPS mới
              </h2>
              <p className="text-xs text-[#8a99ad]">
                Lựa chọn giữa Debian 12 (Linux), Windows 10 IoT Enterprise LTSC 2021 (x64) hoặc Windows 7 (Legacy)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hộp thoại tạo máy ảo"
            className="p-1.5 rounded-lg text-[#8a99ad] hover:text-white hover:bg-[#1e2a44] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-5 overflow-y-auto space-y-3.5">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          {/* OS Selector */}
          <OsSelector
            selectedOs={selectedOs}
            onSelectOs={handleSelectOs}
            osList={osList}
            disabled={isSubmitting}
          />

          {/* Windows 10 IoT Enterprise LTSC 2021 — Read-only Startup Installer Gate Panel */}
          {isWindows10 && (
            <div
              data-testid="modal-win10-phase-a-gate"
              className={`p-3.5 rounded-xl border space-y-2.5 ${
                win10Installer?.status === 'READY'
                  ? 'bg-emerald-500/10 border-emerald-500/30'
                  : win10Installer?.status === 'FAILED'
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-[#2f8bff]/10 border-[#2f8bff]/30'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  {win10Installer?.status === 'READY' ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  ) : win10Installer?.status === 'FAILED' ? (
                    <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  ) : (
                    <RefreshCw className="w-5 h-5 text-[#2f8bff] shrink-0 mt-0.5 animate-spin" />
                  )}
                  <div className="text-xs text-[#c7dcf7] leading-relaxed space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-white">
                        Bộ cài Windows 10 IoT Enterprise LTSC 2021 (x64): {win10Installer?.status || 'NOT_PREPARED'}
                      </span>
                      {win10Installer?.checksumVerified && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono text-[10px]">
                          <CheckCircle2 className="w-3 h-3" /> SHA-256 VERIFIED
                        </span>
                      )}
                    </div>
                    <p>
                      {win10Installer?.status === 'READY'
                        ? win10BaseImage?.ready
                          ? `Bộ cài và ảnh đĩa gốc (windows-10-base.qcow2) đã sẵn sàng khi khởi động server. Tạo VM mới sẽ clone QCOW2 tức thì (không cài lại từ đầu), chạy QEMU Q35 + UEFI OVMF (${win10Installer.hypervisorMode === 'kvm' ? 'KVM' : 'TCG — không dùng /dev/kvm'}).`
                          : `Bộ cài đã được chuẩn bị sẵn khi server khởi động. Tạo VM sẽ dùng trực tiếp bộ cài này (không tải lại hay giải nén lại), chạy QEMU Q35 + UEFI OVMF (${win10Installer.hypervisorMode === 'kvm' ? 'KVM' : 'TCG — không dùng /dev/kvm'}).`
                        : win10Installer?.status === 'FAILED'
                        ? `Chuẩn bị bộ cài khi khởi động server gặp lỗi tại bước ${win10Installer.failedStage || 'trước đó'}: ${win10Installer.error || 'Unknown error'}`
                        : `Đang tự động chuẩn bị nền trong Server Startup (${win10Installer?.progressPercent ?? 0}%). Chờ đạt trạng thái "READY" để tạo máy ảo (Debian 12 vẫn dùng bình thường ngay lúc này).`}
                    </p>
                    {win10Installer?.status === 'FAILED' && win10Installer.remediation && (
                      <p className={`text-[11px] font-medium ${win10Installer.autoRetryScheduled ? 'text-amber-300' : 'text-[#8a99ad]'}`}>
                        {win10Installer.remediation}
                      </p>
                    )}
                    {win10BaseImage && (
                      <p className="text-[11px] font-mono text-[#8a99ad]" title={win10BaseImage.message}>
                        Base QCOW2:{' '}
                        <span className={win10BaseImage.ready ? 'text-emerald-300' : 'text-amber-300/90'}>
                          {win10BaseImage.status}
                        </span>
                        {' — '}
                        {win10BaseImage.message}
                      </p>
                    )}
                    {win10Installer?.sha256Expected && (
                      <p className="text-[11px] font-mono text-[#8a99ad] truncate max-w-xl" title={win10Installer.sha256Expected}>
                        SHA-256 chính thức: {win10Installer.sha256Expected.slice(0, 28)}...
                      </p>
                    )}
                    {kvmAvailable === false && (
                      <p className="text-amber-300/90">
                        Hypervisor: Container không có <code className="font-mono">/dev/kvm</code> — dùng QEMU TCG software emulation ổn định (cài đặt mất nhiều thời gian hơn).
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {isWin10Preparing && (
                <div className="space-y-1">
                  <div className="h-2 w-full bg-[#070b14] rounded-full overflow-hidden border border-[#1e2a44]">
                    <div
                      className="h-full bg-[#2f8bff] transition-all duration-300"
                      style={{ width: `${Math.max(4, Math.min(100, win10Installer?.progressPercent || 0))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-[#8a99ad]">
                    <span>{win10Installer?.status || 'NOT_PREPARED'}</span>
                    <span>{win10Installer?.progressPercent ?? 0}%</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Auto-configured dockurr/windows ISO Engine & Management Panel (Windows 7 only) */}
          {isWindows7 && (
            <div className="p-3.5 rounded-xl bg-sky-500/10 border border-sky-500/30 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <RefreshCw className={`w-5 h-5 text-sky-400 shrink-0 mt-0.5 ${isDownloadingOrVerifying ? 'animate-spin' : ''}`} />
                  <div className="text-xs text-sky-100/90 leading-relaxed space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sky-300">
                        {selectedMedia?.status === 'READY'
                          ? `Bộ cài đặt Windows 7 ISO đã sẵn sàng`
                          : selectedMedia?.status === 'VERIFYING'
                          ? `Đang xác minh mã băm SHA-256 cho ISO...`
                          : selectedMedia?.status === 'DOWNLOADING'
                          ? `Đang tải ISO (${dlMb}/${totalMb} MB — ${selectedMedia.progressPercent || 0}%)`
                          : selectedMedia?.status === 'ERROR'
                          ? `Lỗi tải/xác minh ISO Windows 7`
                          : `Quản lý ISO Windows 7 (VERSION=${selectedMedia?.dockurVersion || '7u'})`}
                      </span>
                      {selectedMedia?.checksumStatus === 'VERIFIED' && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono text-[10px]">
                          <CheckCircle2 className="w-3 h-3" /> SHA-256 VERIFIED
                        </span>
                      )}
                      {selectedMedia?.checksumStatus === 'MISMATCH' && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/40 font-mono text-[10px]">
                          CHECKSUM MISMATCH
                        </span>
                      )}
                    </div>
                    <p className="text-[#c7dcf7]">
                      {selectedMedia?.status === 'READY' && selectedMedia.exists
                        ? `Đã lưu cục bộ (${((selectedMedia.sizeBytes || 0) / (1024 * 1024 * 1024)).toFixed(2)} GiB). Khi tạo VM, hệ thống cũng hỗ trợ stream HTTP-Range NBD để tiết kiệm RAM container.`
                        : 'Hệ thống tự động stream qua NBD (~64 MiB cache) khi khởi tạo VM, hoặc bạn có thể tải sẵn và kiểm tra SHA-256 cục bộ ngay tại đây.'}
                    </p>
                    {selectedMedia?.sha256Expected && (
                      <p className="text-[11px] font-mono text-sky-300/75 truncate max-w-xl" title={selectedMedia.sha256Expected}>
                        SHA-256 chuẩn: {selectedMedia.sha256Expected.slice(0, 24)}...
                      </p>
                    )}
                    {selectedMedia?.error && (
                      <p className="text-red-300 font-mono text-[11px]">
                        {selectedMedia.error} {selectedMedia.remediation ? `— ${selectedMedia.remediation}` : ''}
                      </p>
                    )}
                    {kvmAvailable === false && (
                      <p className="text-amber-300/90">
                        Lưu ý hạ tầng: Máy chủ container không có <code className="font-mono">/dev/kvm</code> (chạy QEMU TCG software emulation{hostMemInfo ? ` • RAM Host: ${hostMemInfo.available} trống / ${hostMemInfo.total}` : ''}).
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Download Progress Bar */}
              {isDownloadingOrVerifying && (
                <div className="space-y-1">
                  <div className="h-2 w-full bg-[#070b14] rounded-full overflow-hidden border border-[#1e2a44]">
                    <div
                      className="h-full bg-[#2f8bff] transition-all duration-300"
                      style={{ width: `${Math.max(2, Math.min(100, selectedMedia?.progressPercent || 0))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-sky-300/80">
                    <span>{selectedMedia?.sourceLabel}</span>
                    <span>{selectedMedia?.progressPercent || 0}%</span>
                  </div>
                </div>
              )}

              {/* ISO Action Buttons */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {isDownloadingOrVerifying ? (
                  <button
                    type="button"
                    disabled={isoActionBusy}
                    onClick={() => handleIsoAction('abort')}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/40 text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    Hủy tải ISO
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={isoActionBusy}
                      onClick={() => handleIsoAction('download')}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070b14] hover:bg-[#1e2a44] text-sky-300 border border-sky-500/40 text-[11px] font-semibold transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {selectedMedia?.status === 'ERROR'
                        ? 'Thử tải lại ISO'
                        : selectedMedia?.exists
                        ? 'Tải lại / Cập nhật ISO'
                        : 'Tải & Kiểm tra ISO (SHA-256)'}
                    </button>
                    {selectedMedia?.exists && (
                      <>
                        <button
                          type="button"
                          disabled={isoActionBusy}
                          onClick={() => handleIsoAction('verify')}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070b14] hover:bg-[#1e2a44] text-emerald-300 border border-emerald-500/40 text-[11px] font-semibold transition-colors cursor-pointer"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Xác minh SHA-256
                        </button>
                        <button
                          type="button"
                          disabled={isoActionBusy}
                          onClick={() => handleIsoAction('delete')}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070b14] hover:bg-red-500/20 text-[#8a99ad] hover:text-red-300 border border-[#1e2a44] text-[11px] font-semibold transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Xóa ISO cục bộ (Giải phóng RAM)
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Windows 7 Security Warning */}
          {selectedOs === 'windows-7' && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200/90 leading-relaxed">
                <span className="font-semibold text-amber-400 block mb-0.5">
                  Lưu ý bảo mật & bộ nhớ Windows 7:
                </span>
                Hệ điều hành Windows 7 đã kết thúc hỗ trợ cập nhật từ Microsoft. Máy ảo được cấu hình chuẩn Legacy PC (i440fx, SeaBIOS, IDE, Intel e1000) và áp dụng giới hạn RAM an toàn chống tràn bộ nhớ (OOM) khi bung file cài đặt.
              </div>
            </div>
          )}

          {/* VM Name */}
          <div className="space-y-1.5">
            <label htmlFor="create-vm-name" className="text-xs font-semibold text-[#8a99ad] uppercase">
              Tên máy ảo (VM Name)
            </label>
            <input
              id="create-vm-name"
              type="text"
              placeholder={
                selectedOs === 'windows-10'
                  ? 'Windows 10 IoT Enterprise LTSC 2021'
                  : selectedOs === 'windows-7'
                  ? 'Cloud Windows 7 Workstation'
                  : 'Cloud Debian 12 Linux'
              }
              value={vmName}
              onChange={(e) => setVmName(e.target.value)}
              disabled={isSubmitting}
              className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#8a99ad]/40 focus:outline-none focus:border-[#2f8bff]"
            />
          </div>

          {/* Resource Configurations */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* CPU Cores */}
            <div className="space-y-1.5">
              <label htmlFor="create-vm-cores" className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> Cores
              </label>
              <select
                id="create-vm-cores"
                value={cores}
                onChange={(e) => setCores(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={1}>1 vCPU</option>
                <option value={2}>2 vCPUs</option>
                <option value={4}>4 vCPUs</option>
              </select>
            </div>

            {/* RAM */}
            <div className="space-y-1.5">
              <label htmlFor="create-vm-ram" className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" /> RAM
              </label>
              <select
                id="create-vm-ram"
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={1024}>1 GB (An toàn Win7 Container)</option>
                <option value={2048}>2 GB (Khuyến nghị Debian/Win7)</option>
                <option value={4096}>4 GB (4096 MB — Chuẩn Win10 LTSC)</option>
                <option value={8192}>8 GB (Host &gt;= 16GB)</option>
              </select>
            </div>

            {/* Disk */}
            <div className="space-y-1.5">
              <label htmlFor="create-vm-disk" className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <HardDrive className="w-3.5 h-3.5" /> Ổ đĩa
              </label>
              <select
                id="create-vm-disk"
                value={diskGb}
                onChange={(e) => setDiskGb(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={20}>20 GB</option>
                <option value={40}>40 GB</option>
                <option value={64}>64 GB (Khuyến nghị Win10 LTSC)</option>
                <option value={80}>80 GB</option>
              </select>
            </div>
          </div>

          {/* Windows 10 Display (VNC) & Network Adapter (Intel e1000e / VirtIO) + Host Quota Check */}
          {isWindows10 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="create-vm-nic" className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                  <Network className="w-3.5 h-3.5" /> Card mạng (Network)
                </label>
                <select
                  id="create-vm-nic"
                  value={networkModel}
                  onChange={(e) => setNetworkModel(e.target.value === 'virtio' ? 'virtio' : 'e1000e')}
                  disabled={isSubmitting}
                  className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
                >
                  <option value="e1000e">Intel e1000e (Tương thích sẵn)</option>
                  <option value="virtio">VirtIO (Hiệu năng cao)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="create-vm-display" className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                  <Monitor className="w-3.5 h-3.5" /> Hiển thị (Display)
                </label>
                <input
                  id="create-vm-display"
                  type="text"
                  readOnly
                  value="VNC (QEMU Framebuffer)"
                  className="w-full bg-[#0a101d] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-[#42d6a0] focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* Host Resource Budget Summary & Phase B Admission Warning */}
          {hostResources && (
            <div className="p-2.5 rounded-lg bg-[#070b14] border border-[#1e2a44] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[#8a99ad]">
              <span>
                RAM khả dụng (≤90%): <strong className="text-white">{hostResources.ram.availableForVmMb} MB</strong> / tối đa {hostResources.ram.maxVmRamMb} MB (chừa {hostResources.ram.reservedHostMb} MB)
              </span>
              <span>
                CPU thực tế: <strong className={hostResources.cpu.throttled ? 'text-red-400' : 'text-[#42d6a0]'}>{hostResources.cpu.realUsagePercent}%</strong> / 95%
              </span>
            </div>
          )}

          {isMediaBlocked && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                {isWin10NotReady
                  ? `Chưa thể tạo Windows 10 VM: Bộ cài đang ở trạng thái "${win10Installer?.status || 'NOT_PREPARED'}" (tự động chuẩn bị khi server khởi động).`
                  : isCpuBlocked
                  ? `CPU máy chủ đang đạt ${hostResources?.cpu.realUsagePercent}% (ngưỡng >= 95%), tạm khóa tạo VM để bảo vệ hệ thống.`
                  : `RAM yêu cầu (${memoryMb} MB) vượt quá RAM khả dụng trong hạn mức 90% (${hostResources?.ram.availableForVmMb ?? 0} MB). Hãy giảm RAM hoặc tắt bớt VM khác.`}
              </span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-4 border-t border-[#1e2a44] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg border border-[#1e2a44] text-[#8a99ad] hover:text-white text-xs font-medium transition-colors cursor-pointer"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isMediaBlocked}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-[#2f8bff] hover:bg-[#2573d9] text-white text-xs font-semibold shadow-lg shadow-[#2f8bff]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Đang khởi tạo VM...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Tạo máy ảo ngay
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
