import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCpuUsageFromSamples,
  evaluateCpuAdmission,
  evaluateRamAdmission,
  parseProcStatCpuSample,
} from './resourceManager';

test('RAM admission strictly enforces 90% ceiling and mandatory 10% host reserve (12 GB example)', () => {
  // 12 GB host = 12288 MB -> max VMs = 11059 MB (10.8 GB), mandatory 10% reserve = 1229 MB (1.2 GB)
  const hostTotalMb = 12288;

  // Scenario A: Other VMs already use 10240 MB (10 GB) -> only 819 MB (0.8 GB) remains in 90% quota
  const overQuota = evaluateRamAdmission({
    hostTotalMb,
    hostAvailableMb: 2048,
    activeVmsRamMb: 10240,
    requestedRamMb: 4096,
  });
  assert.equal(overQuota.allowed, false);
  assert.equal(overQuota.code, 'RAM_LIMIT_90_EXCEEDED');
  assert.equal(overQuota.maxVmRamMb, 11059);
  assert.equal(overQuota.reservedHostMb, 1229);
  assert.equal(overQuota.remainingByQuotaMb, 819);

  // Scenario B: Request fits inside remaining 819 MB AND leaves >= 1229 MB host reserve
  const fitsWithinRemaining = evaluateRamAdmission({
    hostTotalMb,
    hostAvailableMb: 2048,
    activeVmsRamMb: 10240,
    requestedRamMb: 819,
  });
  assert.equal(fitsWithinRemaining.allowed, true);
  assert.equal(fitsWithinRemaining.availableForVmMb, 819);

  // Scenario C: Quota permits 4096 MB, but real hostAvailableMb would dip below 10% reserve (1229 MB)
  const hostTight = evaluateRamAdmission({
    hostTotalMb,
    hostAvailableMb: 4800,
    activeVmsRamMb: 2048,
    requestedRamMb: 4096,
    hypervisorOverheadMb: 448,
  });
  assert.equal(hostTight.allowed, false);
  assert.equal(hostTight.code, 'INSUFFICIENT_HOST_RAM');
  assert.equal(hostTight.remainingByHostAvailableMb, 4800 - 1229);

  // Scenario D: Fresh 12 GB host with Debian 12 (2048 MB) active and 9000 MB real MemAvailable admits 4096 MB Win10
  const win10Admitted = evaluateRamAdmission({
    hostTotalMb,
    hostAvailableMb: 9000,
    activeVmsRamMb: 2048,
    requestedRamMb: 4096,
    hypervisorOverheadMb: 448,
  });
  assert.equal(win10Admitted.allowed, true);
  assert.equal(win10Admitted.remainingByQuotaMb, 11059 - 2048);
});

test('CPU admission checks REAL host CPU usage (< 95%) separately from configured vCPU count and recovers below 95%', () => {
  // Even if configured vCPUs are high (e.g. 6 vCPUs across 4 cores), low real CPU usage (28%) is allowed
  const okHighVcpuLowUsage = evaluateCpuAdmission({
    currentCpuUsagePercent: 28.4,
    totalHostCores: 4,
    activeVmCores: 6,
    requestedCores: 2,
  });
  assert.equal(okHighVcpuLowUsage.allowed, true);

  // Even if only 1 vCPU is configured, if real host CPU usage hits >= 95%, reject!
  const blockedAt95 = evaluateCpuAdmission({
    currentCpuUsagePercent: 95.0,
    totalHostCores: 4,
    activeVmCores: 1,
    requestedCores: 2,
  });
  assert.equal(blockedAt95.allowed, false);
  assert.equal(blockedAt95.code, 'CPU_LIMIT_95_EXCEEDED');
  assert.equal(blockedAt95.reservedHostCpuPercent, 5);

  const blockedAt98 = evaluateCpuAdmission({
    currentCpuUsagePercent: 98.2,
    totalHostCores: 4,
    activeVmCores: 2,
    requestedCores: 2,
  });
  assert.equal(blockedAt98.allowed, false);
  assert.equal(blockedAt98.code, 'CPU_LIMIT_95_EXCEEDED');

  // Once CPU drops back below 95%, allow creation again
  const recovered = evaluateCpuAdmission({
    currentCpuUsagePercent: 91.5,
    totalHostCores: 4,
    activeVmCores: 2,
    requestedCores: 2,
  });
  assert.equal(recovered.allowed, true);

  // Reject single VM requesting more physical cores than host possesses
  const tooManyCores = evaluateCpuAdmission({
    currentCpuUsagePercent: 12,
    totalHostCores: 4,
    activeVmCores: 0,
    requestedCores: 8,
  });
  assert.equal(tooManyCores.allowed, false);
  assert.equal(tooManyCores.code, 'INVALID_CPU_CORES');
});

test('parseProcStatCpuSample and computeCpuUsageFromSamples calculate real CPU utilization accurately', () => {
  const s1 = parseProcStatCpuSample('cpu  1000 0 200 8800 0 0 0 0 0 0\ncpu0 500 0 100 4400 0 0 0 0 0 0');
  const s2 = parseProcStatCpuSample('cpu  1800 0 350 8850 0 0 0 0 0 0\n');
  assert.ok(s1 && s2);
  const pct = computeCpuUsageFromSamples(s1, s2);
  // total delta = 1000, idle delta = 50 -> 95%
  assert.equal(pct, 95);
});
