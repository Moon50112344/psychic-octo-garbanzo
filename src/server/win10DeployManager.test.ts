import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Win10DeployManager, evaluateWin10AutoRetryPolicy } from './win10DeployManager';
import { DOCKUR_MIRROR_CATALOG } from './dockurEngine';
import { evaluateWin10BaseBuildEligibility } from './win10BasePreinstaller';
import { buildWindowsAutounattendXml, buildCredentialSyncScript } from './winAutounattend';

test('Win10DeployManager executes full Phase A sequence and becomes Ready only after all steps succeed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win10-deploy-ok-'));
  const expectedSha = DOCKUR_MIRROR_CATALOG['windows-10'][0].sha256!;
  let downloadCalls = 0;

  try {
    const mgr = new Win10DeployManager({
      rootDir: tmpDir,
      hasKvm: () => false,
      isOverlayFs: () => true,
      getAvailableBytes: () => 20 * 1024 * 1024 * 1024,
      ensureToolchain: async () => ({ ok: true, has7z: true, hasQemu: true, hasOvmf: true }),
      downloadIso: async (destPath, onProgress) => {
        downloadCalls += 1;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        // Simulate file > 500 MiB via sparse file write so stat.size passes size check without wasting RAM
        const fd = fs.openSync(destPath, 'w');
        fs.ftruncateSync(fd, 600 * 1024 * 1024);
        fs.closeSync(fd);
        onProgress({ percent: 50, downloadedBytes: 300 * 1024 * 1024, totalBytes: 600 * 1024 * 1024, provider: 'test' });
        onProgress({ percent: 100, downloadedBytes: 600 * 1024 * 1024, totalBytes: 600 * 1024 * 1024, provider: 'test' });
        return {
          isoPath: destPath,
          sizeBytes: 600 * 1024 * 1024,
          expectedSha256: expectedSha,
          actualSha256: expectedSha,
          checksumVerified: true,
          edition: 'Windows 10 IoT Enterprise LTSC 2021 (x64)',
        };
      },
      verifySha256: async () => expectedSha,
      extractFiles: async (_isoPath, targetDir) => {
        fs.mkdirSync(path.join(targetDir, 'sources'), { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'sources', 'boot.wim'), 'boot');
        fs.writeFileSync(path.join(targetDir, 'setup.exe'), 'setup');
        return {
          extractedCount: 2,
          mode: 'boot-payload-plus-shared-iso',
          wimIndex: 2,
          wimEdition: 'Windows 10 IoT Enterprise LTSC',
        };
      },
    });

    assert.equal(mgr.isReady(), false);
    assert.equal(mgr.getState().status, 'NOT_PREPARED');
    assert.equal(mgr.getState().hypervisorMode, 'tcg');

    // Concurrent calls must coalesce into one pipeline run
    const [finalState, secondJoinState] = await Promise.all([
      mgr.startBackgroundPreparation(),
      mgr.startBackgroundPreparation(),
    ]);
    assert.equal(finalState.status, 'READY');
    assert.equal(secondJoinState.status, 'READY');
    assert.equal(finalState.ready, true);
    assert.equal(finalState.checksumVerified, true);
    assert.equal(finalState.wimIndex, 2);
    assert.equal(downloadCalls, 1);
    assert.ok(mgr.getPreparedArtifact() !== null);

    // Reloading a new manager instance against same data dir restores READY without re-downloading!
    let secondDownloadCalled = false;
    const mgrReloaded = new Win10DeployManager({
      rootDir: tmpDir,
      downloadIso: async () => {
        secondDownloadCalled = true;
        throw new Error('Should not re-download');
      },
    });
    assert.equal(mgrReloaded.isReady(), true);
    assert.equal(mgrReloaded.getState().status, 'READY');
    const reloadedState = await mgrReloaded.startBackgroundPreparation();
    assert.equal(reloadedState.status, 'READY');
    assert.equal(secondDownloadCalled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Win10DeployManager rejects corrupt SHA-256 checksum, marks FAILED, and recovers cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win10-deploy-fail-'));
  const expectedSha = DOCKUR_MIRROR_CATALOG['windows-10'][0].sha256!;
  let attempt = 0;

  try {
    const mgr = new Win10DeployManager({
      rootDir: tmpDir,
      hasKvm: () => false,
      isOverlayFs: () => false,
      getAvailableBytes: () => 40 * 1024 * 1024 * 1024,
      ensureToolchain: async () => ({ ok: true, has7z: true, hasQemu: true, hasOvmf: true }),
      downloadIso: async (destPath) => {
        attempt += 1;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const fd = fs.openSync(destPath, 'w');
        fs.ftruncateSync(fd, 600 * 1024 * 1024);
        fs.closeSync(fd);
        return {
          isoPath: destPath,
          sizeBytes: 600 * 1024 * 1024,
          expectedSha256: expectedSha,
          actualSha256: attempt === 1 ? 'deadbeef'.repeat(8) : expectedSha,
          checksumVerified: attempt > 1,
          edition: 'Windows 10 IoT Enterprise LTSC 2021 (x64)',
        };
      },
      extractFiles: async (_isoPath, targetDir) => {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'setup.exe'), 'ok');
        return {
          extractedCount: 1,
          mode: 'full',
          wimIndex: 1,
          wimEdition: 'Windows 10 IoT Enterprise LTSC',
        };
      },
    });

    const failState = await mgr.startBackgroundPreparation();
    assert.equal(failState.status, 'FAILED');
    assert.equal(failState.ready, false);
    assert.equal(failState.failedStage, 'VERIFYING');
    assert.ok(failState.error?.includes('SHA-256'));
    assert.equal(fs.existsSync(failState.isoPath), false, 'Corrupt ISO must be deleted');

    const retryState = await mgr.retryPreparation();
    assert.equal(retryState.status, 'READY');
    assert.equal(retryState.ready, true);
    assert.equal(attempt, 2);
    mgr.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Win10DeployManager deletes corrupt pre-existing ISO on startup and automatically re-downloads valid copy', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win10-corrupt-preexist-'));
  const expectedSha = DOCKUR_MIRROR_CATALOG['windows-10'][0].sha256!;
  const preIsoPath = path.join(tmpDir, 'data', 'iso', 'windows-10-iot-ltsc-2021-x64.iso');
  fs.mkdirSync(path.dirname(preIsoPath), { recursive: true });
  const fd = fs.openSync(preIsoPath, 'w');
  fs.ftruncateSync(fd, 600 * 1024 * 1024);
  fs.closeSync(fd);

  let downloadCount = 0;
  let verifyCount = 0;

  try {
    const mgr = new Win10DeployManager({
      rootDir: tmpDir,
      hasKvm: () => false,
      isOverlayFs: () => false,
      getAvailableBytes: () => 40 * 1024 * 1024 * 1024,
      ensureToolchain: async () => ({ ok: true, has7z: true, hasQemu: true, hasOvmf: true }),
      verifySha256: async () => {
        verifyCount += 1;
        // First verification inspects pre-existing corrupt ISO -> mismatch; second returns valid SHA
        return verifyCount === 1 ? 'badcafe0'.repeat(8) : expectedSha;
      },
      downloadIso: async (destPath) => {
        downloadCount += 1;
        const wfd = fs.openSync(destPath, 'w');
        fs.ftruncateSync(wfd, 600 * 1024 * 1024);
        fs.closeSync(wfd);
        return {
          isoPath: destPath,
          sizeBytes: 600 * 1024 * 1024,
          expectedSha256: expectedSha,
          actualSha256: expectedSha,
          checksumVerified: true,
          edition: 'Windows 10 IoT Enterprise LTSC 2021 (x64)',
        };
      },
      extractFiles: async (_isoPath, targetDir) => {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'setup.exe'), 'ok');
        return {
          extractedCount: 1,
          mode: 'full',
          wimIndex: 1,
          wimEdition: 'Windows 10 IoT Enterprise LTSC',
        };
      },
    });

    const result = await mgr.startBackgroundPreparation();
    assert.equal(verifyCount, 1);
    assert.equal(downloadCount, 1);
    assert.equal(result.status, 'READY');
    assert.equal(result.ready, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase B Gate: VmManager rejects Windows 10 VM creation if Phase A is not ready or host RAM (>90%) / CPU (>=95%) limits fail', async () => {
  const { vmManager, ProvisioningGateError } = await import('./vmManager');
  const { win10DeployManager } = await import('./win10DeployManager');

  if (!win10DeployManager.isReady()) {
    await assert.rejects(
      () =>
        vmManager.createVm({
          osId: 'windows-10',
          name: 'Blocked-Win10-PhaseB',
          cores: 2,
          memoryMb: 4096,
          diskGb: 64,
        }),
      (err: unknown) => err instanceof ProvisioningGateError && err.code === 'WIN10_INSTALLER_NOT_READY'
    );
  }

  // Over-90% RAM request must always be blocked regardless of Phase A state
  await assert.rejects(
    () =>
      vmManager.createVm({
        osId: 'debian-12',
        name: 'Blocked-Over-90-RAM',
        cores: 2,
        memoryMb: 512 * 1024,
        diskGb: 40,
      }),
    (err: unknown) =>
      err instanceof ProvisioningGateError &&
      (err.code === 'RAM_LIMIT_90_EXCEEDED' || err.code === 'INSUFFICIENT_HOST_RAM')
  );
});

test('evaluateWin10BaseBuildEligibility enforces all 7 gate outcomes accurately', () => {
  const baseParams = {
    alreadyExists: false,
    installerReady: true,
    isMemoryBackedOverlay: false,
    hostTotalMb: 24 * 1024,
    freeDiskBytes: 30 * 1024 * 1024 * 1024,
    hasQemu: true,
    hasOvmf: true,
    hasGenisoimage: true,
    ramAllowed: true,
    cpuThrottled: false,
  };

  const readyRes = evaluateWin10BaseBuildEligibility({ ...baseParams, alreadyExists: true });
  assert.equal(readyRes.eligible, false);
  if (!readyRes.eligible) assert.equal(readyRes.code, 'ALREADY_READY');

  const waitRes = evaluateWin10BaseBuildEligibility({ ...baseParams, installerReady: false });
  assert.equal(waitRes.eligible, false);
  if (!waitRes.eligible) assert.equal(waitRes.code, 'WAIT_FOR_ISO');

  const overlayRes = evaluateWin10BaseBuildEligibility({
    ...baseParams,
    isMemoryBackedOverlay: true,
    hostTotalMb: 12 * 1024,
  });
  assert.equal(overlayRes.eligible, false);
  if (!overlayRes.eligible) assert.equal(overlayRes.code, 'SKIPPED_OVERLAY_RAM_LIMIT');

  // >= 20 GiB RAM overlayfs IS eligible
  const bigOverlayRes = evaluateWin10BaseBuildEligibility({
    ...baseParams,
    isMemoryBackedOverlay: true,
    hostTotalMb: 24 * 1024,
  });
  assert.equal(bigOverlayRes.eligible, true);

  const lowDiskRes = evaluateWin10BaseBuildEligibility({
    ...baseParams,
    freeDiskBytes: 10 * 1024 * 1024 * 1024,
  });
  assert.equal(lowDiskRes.eligible, false);
  if (!lowDiskRes.eligible) assert.equal(lowDiskRes.code, 'SKIPPED_LOW_DISK');

  const missingToolsRes = evaluateWin10BaseBuildEligibility({ ...baseParams, hasGenisoimage: false });
  assert.equal(missingToolsRes.eligible, false);
  if (!missingToolsRes.eligible) assert.equal(missingToolsRes.code, 'SKIPPED_MISSING_TOOLS');

  const ramDeferredRes = evaluateWin10BaseBuildEligibility({ ...baseParams, ramAllowed: false });
  assert.equal(ramDeferredRes.eligible, false);
  if (!ramDeferredRes.eligible) assert.equal(ramDeferredRes.code, 'DEFERRED_RESOURCES');

  const cpuDeferredRes = evaluateWin10BaseBuildEligibility({ ...baseParams, cpuThrottled: true });
  assert.equal(cpuDeferredRes.eligible, false);
  if (!cpuDeferredRes.eligible) assert.equal(cpuDeferredRes.code, 'DEFERRED_RESOURCES');

  const okRes = evaluateWin10BaseBuildEligibility(baseParams);
  assert.equal(okRes.eligible, true);
});

test('buildWindowsAutounattendXml and buildCredentialSyncScript configure sealed base clone sync cleanly', () => {
  const xml = buildWindowsAutounattendXml({
    osId: 'windows-10',
    username: 'Administrator',
    password: 'Strong&Pwd<2026>',
    computerName: 'MOONBASE10',
    wimIndex: 2,
    installCredSyncTask: true,
    shutdownAfterFirstLogon: true,
  });

  assert.ok(xml.includes('<Value>2</Value>'));
  assert.ok(xml.includes('<ProductKey>'));
  assert.ok(xml.includes('<Key />'));
  assert.ok(xml.includes('<SkipAutoActivation>true</SkipAutoActivation>'));
  assert.ok(xml.includes('<PreventDeviceEncryption>true</PreventDeviceEncryption>'));
  assert.ok(xml.includes('Strong&amp;Pwd&lt;2026&gt;'));
  assert.ok(xml.includes('MoonStudioCredSync'));
  assert.ok(xml.includes('sync-cred.cmd'));
  assert.ok(xml.includes('shutdown /s /t 5'));

  const syncScript = buildCredentialSyncScript('MoonUser', 'Pass"2026');
  assert.ok(syncScript.includes('net user "MoonUser" "Pass""2026"'));
  assert.ok(syncScript.includes('net localgroup Administrators "MoonUser" /add'));
  assert.ok(syncScript.includes('fDenyTSConnections'));
  assert.ok(syncScript.includes('remote desktop'));
});

test('Win10DeployManager restores READY immediately from /opt/moon-studio/win10-baked even if runtime data volume is empty', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'win10-baked-root-'));
  const runtimeWorkspace = path.join(tmpRoot, 'runtime-ws');
  const bakedRoot = path.join(tmpRoot, 'win10-baked');
  const expectedSha = DOCKUR_MIRROR_CATALOG['windows-10'][1].sha256!;

  try {
    fs.mkdirSync(path.join(runtimeWorkspace, 'data'), { recursive: true });
    fs.mkdirSync(path.join(bakedRoot, 'iso'), { recursive: true });
    fs.mkdirSync(path.join(bakedRoot, 'installer', 'windows-10', 'files', 'sources'), { recursive: true });

    const bakedIsoPath = path.join(bakedRoot, 'iso', 'windows-10-iot-ltsc-2021-x64.iso');
    const fd = fs.openSync(bakedIsoPath, 'w');
    fs.ftruncateSync(fd, 600 * 1024 * 1024);
    fs.closeSync(fd);

    const bakedFilesDir = path.join(bakedRoot, 'installer', 'windows-10', 'files');
    fs.writeFileSync(path.join(bakedFilesDir, 'sources', 'boot.wim'), 'boot');

    fs.writeFileSync(
      path.join(bakedRoot, 'installer', 'windows-10', 'manifest.json'),
      JSON.stringify({
        ready: true,
        edition: 'Windows 10 IoT Enterprise LTSC 2021 (x64)',
        arch: 'x64',
        isoPath: '/app/data/iso/windows-10-iot-ltsc-2021-x64.iso', // simulates image build path masked by mount
        isoSizeBytes: 600 * 1024 * 1024,
        sha256Expected: expectedSha,
        sha256Actual: expectedSha,
        checksumVerified: true,
        extractedDir: '/app/data/installer/windows-10/files',
        extractionMode: 'boot-payload-plus-shared-iso',
        extractedFilesCount: 1,
        wimIndex: 2,
        wimEdition: 'Windows 10 IoT Enterprise LTSC',
        hypervisorMode: 'tcg',
        storageType: 'workspace-data',
        preparedAt: new Date().toISOString(),
      }),
      'utf8'
    );

    let downloadedAtRuntime = false;
    const mgr = new Win10DeployManager({
      rootDir: runtimeWorkspace,
      bakedRoot,
      downloadIso: async () => {
        downloadedAtRuntime = true;
        throw new Error('Must NOT re-download baked ISO at runtime');
      },
    });

    assert.equal(mgr.isReady(), true);
    const state = mgr.getState();
    assert.equal(state.status, 'READY');
    assert.equal(state.resumeMode, 'cached');
    assert.equal(state.isoPath, bakedIsoPath);
    assert.equal(state.extractedDir, bakedFilesDir);
    await mgr.startBackgroundPreparation();
    assert.equal(downloadedAtRuntime, false);
    mgr.dispose();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('evaluateWin10AutoRetryPolicy retries transient/checksum failures with backoff and blocks disk-full loops', () => {
  const net0 = evaluateWin10AutoRetryPolicy({
    errorMessage: 'curl exit code 56: Recv failure',
    failedStage: 'DOWNLOADING',
    retryCount: 0,
  });
  assert.equal(net0.shouldRetry, true);
  assert.equal(net0.delayMs, 15_000);

  const net2 = evaluateWin10AutoRetryPolicy({
    errorMessage: 'curl exit code 22: HTTP 503',
    failedStage: 'DOWNLOADING',
    retryCount: 2,
  });
  assert.equal(net2.shouldRetry, true);
  assert.equal(net2.delayMs, 60_000);

  const shaErr = evaluateWin10AutoRetryPolicy({
    errorMessage: 'Xác minh SHA-256 thất bại cho ISO',
    failedStage: 'VERIFYING',
    retryCount: 1,
  });
  assert.equal(shaErr.shouldRetry, true);
  assert.equal(shaErr.delayMs, 30_000);

  const diskFull = evaluateWin10AutoRetryPolicy({
    errorMessage: 'Không đủ dung lượng lưu trữ để tải & chuẩn bị Windows 10',
    failedStage: 'DOWNLOADING',
    retryCount: 0,
  });
  assert.equal(diskFull.shouldRetry, false);

  const maxReached = evaluateWin10AutoRetryPolicy({
    errorMessage: 'curl exit code 28',
    failedStage: 'DOWNLOADING',
    retryCount: 10,
    maxAutoRetries: 10,
  });
  assert.equal(maxReached.shouldRetry, false);
});

test('Win10DeployManager autonomously retries after FAILED download without manual trigger and emits onReady', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win10-autoretry-'));
  const expectedSha = DOCKUR_MIRROR_CATALOG['windows-10'][0].sha256!;
  let downloadAttempts = 0;
  let readyCallbackCount = 0;
  let mgr: Win10DeployManager | null = null;

  try {
    mgr = new Win10DeployManager({
      rootDir: tmpDir,
      hasKvm: () => false,
      isOverlayFs: () => false,
      getAvailableBytes: () => 40 * 1024 * 1024 * 1024,
      maxAutoRetries: 3,
      autoRetryDelayMs: () => 25,
      ensureToolchain: async () => ({ ok: true, has7z: true, hasQemu: true, hasOvmf: true }),
      downloadIso: async (destPath) => {
        downloadAttempts += 1;
        if (downloadAttempts === 1) {
          throw new Error('Auto-download exited with code 22: HTTP 503 Service Unavailable');
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const fd = fs.openSync(destPath, 'w');
        fs.ftruncateSync(fd, 600 * 1024 * 1024);
        fs.closeSync(fd);
        return {
          isoPath: destPath,
          sizeBytes: 600 * 1024 * 1024,
          expectedSha256: expectedSha,
          actualSha256: expectedSha,
          checksumVerified: true,
          edition: 'Windows 10 IoT Enterprise LTSC 2021 (x64)',
        };
      },
      extractFiles: async (_isoPath, targetDir) => {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'setup.exe'), 'ok');
        return {
          extractedCount: 1,
          mode: 'full',
          wimIndex: 1,
          wimEdition: 'Windows 10 IoT Enterprise LTSC',
        };
      },
    });

    mgr.onReady((s) => {
      if (s.ready && s.status === 'READY') readyCallbackCount += 1;
    });

    const firstResult = await mgr.startBackgroundPreparation();
    assert.equal(firstResult.status, 'FAILED');
    assert.equal(firstResult.autoRetryScheduled, true);
    assert.ok(firstResult.nextRetryAt);
    assert.equal(readyCallbackCount, 0);

    // Wait for autonomous background retry timer to complete without calling retryPreparation()
    const deadline = Date.now() + 2000;
    while (!mgr.isReady() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const finalState = mgr.getState();
    assert.equal(finalState.status, 'READY');
    assert.equal(finalState.ready, true);
    assert.equal(finalState.retryCount, 1);
    assert.equal(finalState.autoRetryScheduled, false);
    assert.equal(downloadAttempts, 2);
    assert.equal(readyCallbackCount, 1);
  } finally {
    mgr?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



