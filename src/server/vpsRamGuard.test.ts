import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateVpsRamReduction,
  isProtectedHostProcess,
  readPidRssMb,
  VPS_RAM_REDUCE_THRESHOLD_PERCENT,
} from './vpsRamGuard';

test('VPS RAM guard skips below 95% and triggers at 95% and 96%+', () => {
  const below = evaluateVpsRamReduction({
    vmId: 'vm-deb',
    osId: 'debian-12',
    allocatedMemoryMb: 2048,
    usedMemoryMb: 1943, // 94.9%
    nowMs: 100_000,
  });
  assert.equal(below.shouldReduce, false);
  assert.equal(below.skipReason, 'BELOW_THRESHOLD');
  assert.equal(below.thresholdPercent, VPS_RAM_REDUCE_THRESHOLD_PERCENT);

  const at95 = evaluateVpsRamReduction({
    vmId: 'vm-deb',
    osId: 'debian-12',
    allocatedMemoryMb: 2048,
    usedMemoryMb: 1946, // 95.0%
    nowMs: 100_000,
  });
  assert.equal(at95.shouldReduce, true);
  assert.ok(at95.usedPercent >= 95);
  assert.equal(at95.targetMemoryMb, 1638);

  const at96 = evaluateVpsRamReduction({
    vmId: 'vm-deb',
    osId: 'debian-12',
    allocatedMemoryMb: 2048,
    usedMemoryMb: 1970, // 96.2%
    nowMs: 100_000,
  });
  assert.equal(at96.shouldReduce, true);
  assert.ok(at96.usedPercent >= 96);
});

test('Host server and hypervisor processes are strictly protected from VPS process trimming', () => {
  assert.equal(
    isProtectedHostProcess({ pid: 1, user: 'root', rssMb: 100, comm: 'init' }),
    true
  );
  assert.equal(
    isProtectedHostProcess({ pid: process.pid, user: 'root', rssMb: 200, comm: 'node' }),
    true
  );
  for (const hostProc of ['node', 'tsx', 'bore', 'xrdp', 'xrdp-sesman', 'qemu-system-x86_64', 'swtpm']) {
    assert.equal(
      isProtectedHostProcess({ pid: 9999, user: 'Administrator', rssMb: 900, comm: hostProc }),
      true,
      `Expected ${hostProc} to be protected`
    );
  }
  assert.equal(
    isProtectedHostProcess({ pid: 4512, user: 'Administrator', rssMb: 750, comm: 'firefox-esr' }),
    false
  );
});

test('Debian 12 VPS trimming picks highest-RSS VPS user processes down to target without touching host daemons', () => {
  const plan = evaluateVpsRamReduction({
    vmId: 'vm-deb-01',
    osId: 'debian-12',
    allocatedMemoryMb: 2048,
    usedMemoryMb: 1966, // 96.0% -> need to reclaim ~328 MB to reach 1638 MB (80%)
    nowMs: 200_000,
    processCandidates: [
      { pid: 1200, user: 'Administrator', rssMb: 600, comm: 'node' }, // protected host process
      { pid: 1201, user: 'Administrator', rssMb: 250, comm: 'chromium' },
      { pid: 1202, user: 'Administrator', rssMb: 150, comm: 'python3' },
      { pid: 1203, user: 'Administrator', rssMb: 40, comm: 'xfce4-terminal' },
    ],
  });

  assert.equal(plan.shouldReduce, true);
  assert.equal(plan.strategy, 'vps-process-trim');
  assert.deepEqual(
    plan.processesToTrim.map((p) => p.comm),
    ['chromium', 'python3']
  );
  assert.equal(plan.projectedReclaimMb, 400);
});

test('Windows 10 and Windows 7 QEMU balloon targets honor OS safe RAM floors', () => {
  const win10Plan = evaluateVpsRamReduction({
    vmId: 'vm-w10',
    osId: 'windows-10',
    allocatedMemoryMb: 4096,
    usedMemoryMb: 3932, // 96%
    nowMs: 300_000,
  });
  assert.equal(win10Plan.shouldReduce, true);
  assert.equal(win10Plan.strategy, 'qemu-balloon');
  assert.equal(win10Plan.targetMemoryMb, 3276); // 80% of 4096

  const win10SmallPlan = evaluateVpsRamReduction({
    vmId: 'vm-w10-min',
    osId: 'windows-10',
    allocatedMemoryMb: 1800,
    usedMemoryMb: 1728, // 96%
    nowMs: 300_000,
  });
  assert.equal(win10SmallPlan.targetMemoryMb, 1536); // Win10 floor

  const win7Plan = evaluateVpsRamReduction({
    vmId: 'vm-w7',
    osId: 'windows-7',
    allocatedMemoryMb: 1024,
    usedMemoryMb: 983, // 96%
    nowMs: 300_000,
  });
  assert.equal(win7Plan.strategy, 'qemu-balloon');
  assert.equal(win7Plan.targetMemoryMb, 819); // 80% of 1024 > 768 floor
});

test('Cooldown blocks rapid repeated VPS RAM reductions and permits after expiry', () => {
  const blocked = evaluateVpsRamReduction({
    vmId: 'vm-deb-01',
    osId: 'debian-12',
    allocatedMemoryMb: 2048,
    usedMemoryMb: 1966,
    lastReducedAtMs: 95_000,
    nowMs: 100_000,
    cooldownMs: 15_000,
  });
  assert.equal(blocked.shouldReduce, false);
  assert.equal(blocked.skipReason, 'COOLDOWN_ACTIVE');

  const allowed = evaluateVpsRamReduction({
    vmId: 'vm-deb-01',
    osId: 'debian-12',
    allocatedMemoryMb: 2048,
    usedMemoryMb: 1966,
    lastReducedAtMs: 80_000,
    nowMs: 100_000,
    cooldownMs: 15_000,
  });
  assert.equal(allowed.shouldReduce, true);
});

test('readPidRssMb returns real positive RSS for current node process', () => {
  const rssMb = readPidRssMb(process.pid);
  assert.ok(rssMb > 5, `Expected positive RSS MB, got ${rssMb}`);
});
