import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCKUR_MIRROR_CATALOG,
  getDockurVersionCode,
  getOrderedMirrorsForOs,
  buildDockurContainerSpec,
  inspectDockerfileSetup,
  planPartialIsoAction,
  isRetryableCurlOutcome,
  computeCurlRetryDelayMs,
} from './dockurEngine';
import { parseMountedPersistentPaths, resolvePersistentStorageRoot } from './storagePath';

test('dockurEngine maps OS IDs to official dockurr/windows VERSION tags automatically', () => {
  assert.equal(getDockurVersionCode('windows-10'), '10');
  assert.equal(getDockurVersionCode('windows-7'), '7u');
  assert.equal(getDockurVersionCode('debian-12'), 'debian-12');
});

test('dockurEngine mirror catalog includes valid genuine Windows 10 and Windows 7 mirrors', () => {
  assert.ok(DOCKUR_MIRROR_CATALOG['windows-10'].length >= 2);
  assert.ok(DOCKUR_MIRROR_CATALOG['windows-7'].length >= 2);
  for (const item of [...DOCKUR_MIRROR_CATALOG['windows-10'], ...DOCKUR_MIRROR_CATALOG['windows-7']]) {
    assert.ok(item.url.startsWith('https://'));
    assert.ok(item.expectedSizeBytes > 3 * 1024 * 1024 * 1024);
  }
});

test('dockurEngine prioritizes compact Windows 10 ISO first when host disk free space is under 14 GiB', () => {
  const tightOrdered = getOrderedMirrorsForOs('windows-10', 11 * 1024 * 1024 * 1024);
  const spaciousOrdered = getOrderedMirrorsForOs('windows-10', 40 * 1024 * 1024 * 1024);

  assert.ok(tightOrdered[0].expectedSizeBytes <= tightOrdered[1].expectedSizeBytes);
  assert.equal(tightOrdered[0].id, 'archive-win10-iot-ltsc-2021');
  assert.equal(spaciousOrdered[0].id, 'archive-win10-iot-ltsc-2021');
  assert.ok(tightOrdered[0].sha256 && tightOrdered[0].sha256.length === 64);
});

test('dockurEngine builds valid dockurr/windows docker run spec without manual ISO paths', () => {
  const spec = buildDockurContainerSpec({
    vmId: 'vm-win10-test',
    osId: 'windows-10',
    cores: 2,
    memoryMb: 4096,
    diskGb: 40,
    username: 'Administrator',
    password: 'StrongPassword#2026',
    rdpPort: 3390,
    webPort: 8006,
  });

  assert.equal(spec.image, 'dockurr/windows:latest');
  assert.equal(spec.versionTag, '10');
  assert.ok(spec.args.includes('VERSION=10'));
  assert.ok(spec.args.includes('RAM_SIZE=4G'));
  assert.ok(spec.args.includes('CPU_CORES=2'));
  assert.ok(spec.args.includes('DISK_SIZE=40G'));
  assert.ok(spec.args.includes('3390:3389/tcp'));
  assert.ok(spec.args.includes('8006:8006'));
  assert.equal(spec.args.some((a) => a.includes('ISO_PATH')), false);
});

test('Dockerfile and docker-compose.yml support ISO download and runtime without requiring /dev/kvm', () => {
  const setup = inspectDockerfileSetup();
  assert.equal(setup.dockerfilePresent, true);
  assert.equal(setup.dockerComposePresent, true);
  assert.equal(setup.requiresDevKvm, false);
  assert.deepEqual(setup.supportedTargets, ['iso-downloader', 'runtime']);

  const dockerfile = fs.readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('AS iso-downloader'));
  assert.ok(dockerfile.includes('AS runtime'));
  assert.ok(dockerfile.includes('KVM=N'));
  assert.ok(dockerfile.includes('download-windows-iso.sh'));
  assert.ok(dockerfile.includes('ARG DOWNLOAD_WIN10=true'));
  assert.ok(dockerfile.includes('ARG PREINSTALL_WIN10=false'));
  assert.ok(dockerfile.includes('PORT=8080'));
  assert.ok(dockerfile.includes('EXPOSE 8080 3389'));
  assert.ok(dockerfile.includes('COPY --from=iso-downloader /app/data/installer /app/data/installer'));
  assert.ok(dockerfile.includes('manifest.json'));
  assert.ok(dockerfile.includes('scripts/preinstall-win10-base.ts'));
  assert.ok(dockerfile.includes('scripts/verify-win10-baked.ts'));
  assert.ok(dockerfile.includes('/opt/moon-studio/win10-baked'));
  assert.ok(dockerfile.includes('MATCHED_SHA'));
  assert.equal(dockerfile.includes('7z l -ba'), false);

  const dockerignore = fs.readFileSync(path.join(process.cwd(), '.dockerignore'), 'utf8');
  assert.ok(dockerignore.split(/\r?\n/).some((line) => line.trim() === 'data'));

  const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
  assert.equal(compose.includes('/dev/kvm'), false);
  assert.ok(compose.includes('KVM: "N"'));
  assert.ok(compose.includes('dockerfile: Dockerfile'));
  assert.ok(compose.includes('DOWNLOAD_WIN10: "true"'));
  assert.ok(compose.includes('PORT: "8080"'));
});

test('planPartialIsoAction selects start-fresh, resume-range, restart-fresh, and promote accurately', () => {
  assert.equal(
    planPartialIsoAction({ partialBytes: 0, expectedSizeBytes: 1000, rangeSupported: true }).action,
    'start-fresh'
  );
  assert.equal(
    planPartialIsoAction({ partialBytes: 400, expectedSizeBytes: 1000, rangeSupported: true }).action,
    'resume-range'
  );
  assert.equal(
    planPartialIsoAction({ partialBytes: 400, expectedSizeBytes: 1000, rangeSupported: false }).action,
    'restart-fresh'
  );
  assert.equal(
    planPartialIsoAction({ partialBytes: 1200, expectedSizeBytes: 1000, rangeSupported: true }).action,
    'restart-fresh'
  );
  assert.equal(
    planPartialIsoAction({ partialBytes: 1000, expectedSizeBytes: 1000, rangeSupported: true }).action,
    'promote'
  );
});

test('storagePath detects non-ephemeral persistent volumes and falls back cleanly to workspace data/', () => {
  const procMounts = [
    'none / overlay rw 0 0',
    'tmpfs /data tmpfs rw 0 0',
    '/dev/sdb1 /mnt/data ext4 rw 0 0',
  ].join('\n');
  const mounts = parseMountedPersistentPaths(procMounts);
  assert.deepEqual(mounts, [{ mountPoint: '/mnt/data', fsType: 'ext4' }]);

  const viaMount = resolvePersistentStorageRoot({
    workspaceRoot: '/app/workspace',
    env: {},
    procMountsContent: procMounts,
    isWritableDir: (d) => d === '/mnt/data/moon-cloud',
  });
  assert.equal(viaMount.storageType, 'persistent-volume');
  assert.equal(viaMount.dataDir, '/mnt/data/moon-cloud');

  const viaEnv = resolvePersistentStorageRoot({
    workspaceRoot: '/app/workspace',
    env: { MOON_STORAGE_DIR: '/custom/persist' },
    procMountsContent: procMounts,
    isWritableDir: () => true,
  });
  assert.equal(viaEnv.storageType, 'persistent-volume');
  assert.equal(viaEnv.dataDir, '/custom/persist');

  const fallback = resolvePersistentStorageRoot({
    workspaceRoot: '/tmp/test-moon-ws',
    env: {},
    procMountsContent: 'none / overlay rw 0 0',
    isWritableDir: () => false,
  });
  assert.equal(fallback.storageType, 'workspace-data');
  assert.equal(fallback.dataDir, '/tmp/test-moon-ws/data');
});

test('dockurEngine classifies transient curl/HTTP errors and computes progressive backoff delays', () => {
  for (const code of [6, 7, 18, 22, 28, 33, 35, 52, 55, 56, 92, -4]) {
    assert.equal(isRetryableCurlOutcome(code), true, `Expected code ${code} to be retryable`);
  }
  assert.equal(isRetryableCurlOutcome(-3), false); // checksum mismatch triggers mirror switch
  assert.equal(isRetryableCurlOutcome(-2), false); // manual abort

  assert.equal(computeCurlRetryDelayMs(1), 2000);
  assert.equal(computeCurlRetryDelayMs(2), 4000);
  assert.equal(computeCurlRetryDelayMs(3), 6000);
  assert.equal(computeCurlRetryDelayMs(10), 15000);
});
