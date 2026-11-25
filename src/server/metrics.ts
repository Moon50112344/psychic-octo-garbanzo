import os from 'node:os';
import { vmManager } from './vmManager';
import { hostResourceManager } from './resourceManager';
import {
  VPS_RAM_REDUCE_THRESHOLD_PERCENT,
  VpsRamReductionEvent,
} from './vpsRamGuard';

export interface MetricSample {
  time: string;
  cpu: number;
  memory: number;
  memoryMb: number;
  totalMemoryMb: number;
}

export interface VmMetricsResponse {
  success: boolean;
  vmId: string;
  vmName: string;
  cores: number;
  cpuPercent: number;
  memoryMb: number;
  totalMemoryMb: number;
  memoryPercent: number;
  autoRamReduceEnabled: boolean;
  autoRamReduceThresholdPercent: number;
  lastAutoRamReduction: VpsRamReductionEvent | null;
  uptimeSeconds: number;
  timestamp: string;
  history: MetricSample[];
}

export class VmMetricsCollector {
  private historyMap: Map<string, MetricSample[]> = new Map();
  private maxHistory = 20;

  constructor() {
    this.seedInitialHistory();
  }

  private getCpuUsage(): number {
    const pct = hostResourceManager.getRealCpuUsagePercent();
    return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
  }

  private seedInitialHistory(): void {
    const now = Date.now();
    const defaultHistory: MetricSample[] = [];
    const baseMemMb = 140;
    const baseTotalMb = 2048;
    const baseMemPct = Math.round((baseMemMb / baseTotalMb) * 100);

    // Generate 12 baseline points aligned with lightweight VPS session memory
    for (let i = 12; i >= 1; i--) {
      const pointTime = new Date(now - i * 3000);
      const timeStr = pointTime.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const jitter = Math.sin(i) * 2;
      const cpu = Math.max(1, Math.min(95, Math.round(6 + jitter)));

      defaultHistory.push({
        time: timeStr,
        cpu,
        memory: baseMemPct,
        memoryMb: baseMemMb,
        totalMemoryMb: baseTotalMb,
      });
    }

    this.historyMap.set('default', defaultHistory);
  }

  public getMetrics(vmId?: string): VmMetricsResponse {
    const allVms = vmManager.getAllVms();
    const targetVm = vmId ? vmManager.getVm(vmId) : (vmManager.getPrimaryVm() || allVms[0]);

    const currentVmId = vmId || (targetVm ? targetVm.id : 'vm-default');
    const vmName = targetVm ? targetVm.name : (vmId ? `VM ${vmId}` : 'Cloud VM Instance');
    const cores = targetVm ? targetVm.cores : 2;
    const targetTotalMemMb = targetVm ? targetVm.memoryMb : 2048;

    let memoryMb = 0;
    if (targetVm) {
      memoryMb = vmManager.measureVmUsedMemoryMb(targetVm.id);
    } else {
      memoryMb = 140;
    }

    const memoryPercent =
      targetVm && (targetVm.status === 'Stopped' || targetVm.status === 'Failed')
        ? 0
        : Math.min(100, Math.max(1, Math.round((memoryMb / Math.max(1, targetTotalMemMb)) * 100)));

    if (
      targetVm &&
      memoryPercent >= VPS_RAM_REDUCE_THRESHOLD_PERCENT &&
      (targetVm.status === 'Ready' ||
        targetVm.status === 'Running' ||
        targetVm.status === 'Installing' ||
        targetVm.status === 'Booting')
    ) {
      void vmManager.evaluateAndReduceVpsRam(targetVm.id, memoryMb);
    }

    const cpuPercent = this.getCpuUsage();
    const nowTimeStr = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let history = this.historyMap.get(currentVmId);
    if (!history || history.length === 0) {
      history = [...(this.historyMap.get('default') || [])];
    }

    const newSample: MetricSample = {
      time: nowTimeStr,
      cpu: cpuPercent,
      memory: memoryPercent,
      memoryMb,
      totalMemoryMb: targetTotalMemMb,
    };

    history.push(newSample);
    if (history.length > this.maxHistory) {
      history = history.slice(-this.maxHistory);
    }
    this.historyMap.set(currentVmId, history);

    return {
      success: true,
      vmId: currentVmId,
      vmName,
      cores,
      cpuPercent,
      memoryMb,
      totalMemoryMb: targetTotalMemMb,
      memoryPercent,
      autoRamReduceEnabled: true,
      autoRamReduceThresholdPercent: VPS_RAM_REDUCE_THRESHOLD_PERCENT,
      lastAutoRamReduction: targetVm ? vmManager.getLastVpsRamReduction(targetVm.id) : null,
      uptimeSeconds: Math.round(os.uptime()),
      timestamp: new Date().toISOString(),
      history,
    };
  }
}

export const vmMetricsCollector = new VmMetricsCollector();
