import React, { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  SkipForward,
  RotateCw,
  Download,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type {
  DeploymentStageItem,
  DeploymentStageKey,
  IsoDownloadProgress,
} from '../server/win7Lifecycle';
import { calculateDeploymentOverallPercent } from '../server/win7Lifecycle';

interface DeploymentProgressCardProps {
  vmId?: string;
  osName?: string;
  status?: string;
  deploymentStage?: DeploymentStageKey;
  deploymentStages?: DeploymentStageItem[];
  isoProgress?: IsoDownloadProgress;
  failureReason?: string;
  statusMessage?: string;
  remediation?: string;
  actionLoading?: boolean;
  onRetry?: () => void;
}

export function DeploymentProgressCard({
  vmId,
  osName,
  status,
  deploymentStages,
  isoProgress,
  failureReason,
  statusMessage,
  remediation,
  actionLoading = false,
  onRetry,
}: DeploymentProgressCardProps) {
  const isReady = status === 'Online' || status === 'Ready' || status === 'Running';
  const isFailed = status === 'Failed';
  const [expandedWhenReady, setExpandedWhenReady] = useState(false);

  if (!Array.isArray(deploymentStages) || deploymentStages.length === 0) {
    return null;
  }

  const overallPercent = calculateDeploymentOverallPercent(deploymentStages, isoProgress);
  const completedCount = deploymentStages.filter(
    (s) => s.status === 'completed' || s.status === 'skipped'
  ).length;
  const activeStage = deploymentStages.find((s) => s.status === 'active');
  const failedStage = deploymentStages.find((s) => s.status === 'failed');
  const showChecklist = !isReady || expandedWhenReady;

  const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div
      data-testid="deployment-progress-card"
      className={`rounded-xl border p-4 space-y-3.5 transition-colors ${
        isFailed
          ? 'bg-red-500/5 border-red-500/35'
          : isReady
          ? 'bg-emerald-500/5 border-emerald-500/30'
          : 'bg-[#070b14] border-[#2f8bff]/40'
      }`}
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {isFailed ? (
            <XCircle className="w-5 h-5 text-red-400 shrink-0" />
          ) : isReady ? (
            <CheckCircle2 className="w-5 h-5 text-[#42d6a0] shrink-0" />
          ) : (
            <Loader2 className="w-5 h-5 text-[#2f8bff] animate-spin shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-xs sm:text-sm font-bold text-white tracking-wide">
                {isReady
                  ? `Triển khai ${osName || 'VPS'} hoàn tất`
                  : isFailed
                  ? `Triển khai ${osName || 'VPS'} gặp lỗi tại bước: ${failedStage?.label || 'Provisioning'}`
                  : `Đang triển khai ${osName || 'Windows 7'} — ${activeStage?.label || 'Processing'}`}
              </h4>
              {isoProgress?.cachedReused && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 font-mono text-[10px]">
                  <ShieldCheck className="w-3 h-3" /> ISO CACHE REUSED
                </span>
              )}
              {isoProgress?.checksumVerified && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/35 font-mono text-[10px]">
                  SHA-256 OK
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#8a99ad] truncate">
              {statusMessage ||
                (isReady
                  ? `Tất cả ${deploymentStages.length} giai đoạn triển khai đã hoàn tất.`
                  : `Giai đoạn ${completedCount}/${deploymentStages.length}${vmId ? ` • ${vmId}` : ''}`)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <span
            data-testid="deployment-overall-percent"
            className={`px-2.5 py-1 rounded-lg font-mono text-xs font-bold border ${
              isFailed
                ? 'bg-red-500/15 text-red-300 border-red-500/40'
                : isReady
                ? 'bg-[#42d6a0]/15 text-[#42d6a0] border-[#42d6a0]/40'
                : 'bg-[#2f8bff]/15 text-[#2f8bff] border-[#2f8bff]/40'
            }`}
          >
            {overallPercent}%
          </span>

          {isReady && (
            <button
              type="button"
              onClick={() => setExpandedWhenReady((prev) => !prev)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#0d1424] hover:bg-[#1e2a44] border border-[#1e2a44] text-[11px] text-[#8a99ad] hover:text-white transition-colors cursor-pointer"
            >
              {expandedWhenReady ? (
                <>
                  <span>Thu gọn</span>
                  <ChevronUp className="w-3.5 h-3.5" />
                </>
              ) : (
                <>
                  <span>Chi tiết ({deploymentStages.length} bước)</span>
                  <ChevronDown className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Overall Progress Bar */}
      <div className="h-2 w-full bg-[#0d1424] rounded-full overflow-hidden border border-[#1e2a44]">
        <div
          className={`h-full transition-all duration-300 ${
            isFailed ? 'bg-red-500' : isReady ? 'bg-[#42d6a0]' : 'bg-[#2f8bff]'
          }`}
          style={{ width: `${Math.max(isReady ? 100 : 4, overallPercent)}%` }}
        />
      </div>

      {/* Real ISO Download & Integrity Sub-Panel */}
      {isoProgress &&
        (isoProgress.status === 'downloading' ||
          isoProgress.status === 'verifying' ||
          (isoProgress.status === 'failed' && isoProgress.downloadedBytes > 0) ||
          (!isReady && isoProgress.totalBytes > 0)) && (
          <div className="p-2.5 rounded-lg bg-[#0d1424] border border-[#1e2a44] space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
              <span className="inline-flex items-center gap-1.5 text-sky-300 font-semibold">
                <Download className="w-3.5 h-3.5" />
                {isoProgress.status === 'verifying'
                  ? 'Đang xác minh SHA-256 & cấu trúc bộ cài...'
                  : isoProgress.status === 'cached' || isoProgress.cachedReused
                  ? 'Tái sử dụng Windows ISO đã xác minh từ cache'
                  : isoProgress.status === 'failed'
                  ? `Tạm dừng có thể khôi phục: ${formatMb(isoProgress.downloadedBytes)}${
                      isoProgress.totalBytes > 0 ? ` / ${formatMb(isoProgress.totalBytes)}` : ''
                    }`
                  : `Đang tải ISO: ${formatMb(isoProgress.downloadedBytes)}${
                      isoProgress.totalBytes > 0 ? ` / ${formatMb(isoProgress.totalBytes)}` : ''
                    }`}
              </span>
              <span className="text-[#8a99ad]">
                {isoProgress.percent}%{isoProgress.provider ? ` • ${isoProgress.provider}` : ''}
              </span>
            </div>
            <div className="h-1.5 w-full bg-[#070b14] rounded-full overflow-hidden border border-[#1e2a44]">
              <div
                className={`h-full transition-all duration-300 ${
                  isoProgress.status === 'failed' ? 'bg-amber-400' : 'bg-sky-400'
                }`}
                style={{ width: `${Math.max(2, Math.min(100, isoProgress.percent || 0))}%` }}
              />
            </div>
          </div>
        )}

      {/* 12-Stage Checklist */}
      {showChecklist && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {deploymentStages.map((stage, idx) => {
            const isStageDone = stage.status === 'completed';
            const isStageSkipped = stage.status === 'skipped';
            const isStageActive = stage.status === 'active';
            const isStageFailed = stage.status === 'failed';

            return (
              <div
                key={stage.key}
                data-stage-key={stage.key}
                data-stage-status={stage.status}
                className={`p-2 rounded-lg border text-xs flex items-start gap-2 transition-colors ${
                  isStageFailed
                    ? 'bg-red-500/10 border-red-500/40 text-red-200'
                    : isStageActive
                    ? 'bg-[#2f8bff]/15 border-[#2f8bff]/50 text-white shadow-sm'
                    : isStageDone
                    ? 'bg-[#42d6a0]/5 border-[#42d6a0]/30 text-[#d4f5e9]'
                    : isStageSkipped
                    ? 'bg-[#0d1424]/70 border-[#1e2a44] text-[#8a99ad]'
                    : 'bg-[#0d1424]/40 border-[#1e2a44]/60 text-[#8a99ad]/60'
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {isStageDone ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#42d6a0]" />
                  ) : isStageSkipped ? (
                    <SkipForward className="w-3.5 h-3.5 text-emerald-400/70" />
                  ) : isStageActive ? (
                    <Loader2 className="w-3.5 h-3.5 text-[#2f8bff] animate-spin" />
                  ) : isStageFailed ? (
                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-[#8a99ad]/40" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold truncate">
                      {idx + 1}. {stage.label}
                    </span>
                  </div>
                  {stage.detail && (
                    <p className="text-[10px] font-mono opacity-80 truncate mt-0.5" title={stage.detail}>
                      {stage.detail}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Retry Bar on Failure (same VPS, preserves resumable ISO downloads) */}
      {isFailed && onRetry && (
        <div className="pt-2 border-t border-red-500/25 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-red-200/90 space-y-0.5">
            {failureReason && <p className="font-mono text-red-300">{failureReason}</p>}
            {remediation && <p className="text-amber-300/90">Khắc phục: {remediation}</p>}
          </div>
          <button
            type="button"
            disabled={actionLoading}
            onClick={onRetry}
            data-testid="retry-deployment-button"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2f8bff] hover:bg-[#2573d9] text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${actionLoading ? 'animate-spin' : ''}`} />
            <span>Thử lại triển khai (Không tạo VPS trùng)</span>
          </button>
        </div>
      )}
    </div>
  );
}
