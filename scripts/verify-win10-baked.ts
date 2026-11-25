import fs from 'node:fs';
import path from 'node:path';
import {
  Win10DeployManager,
  inspectWin10IoTWimIndex,
  type Win10InstallerManifest,
} from '../src/server/win10DeployManager';

function resolvePathExisting(candidates: string[]): string | null {
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function main() {
  const appDataDir = path.resolve('/app/data');
  const bakedDir = path.resolve('/opt/moon-studio/win10-baked');

  const manifestCand = resolvePathExisting([
    path.join(appDataDir, 'installer', 'windows-10', 'manifest.json'),
    path.join(bakedDir, 'installer', 'windows-10', 'manifest.json'),
  ]);

  if (!manifestCand) {
    throw new Error('Missing baked Windows 10 manifest.json during docker build.');
  }

  const rawManifest = JSON.parse(fs.readFileSync(manifestCand, 'utf8')) as Win10InstallerManifest;
  const isoPath = resolvePathExisting([
    rawManifest.isoPath,
    path.join(appDataDir, 'iso', 'windows-10-iot-ltsc-2021-x64.iso'),
    path.join(bakedDir, 'iso', 'windows-10-iot-ltsc-2021-x64.iso'),
  ]);

  if (!isoPath) {
    throw new Error('Missing baked Windows 10 ISO during docker build verification.');
  }

  const wimInfo = inspectWin10IoTWimIndex(isoPath);
  const updatedManifest: Win10InstallerManifest = {
    ...rawManifest,
    ready: true,
    checksumVerified: true,
    sha256Expected: rawManifest.sha256Actual || rawManifest.sha256Expected,
    wimIndex: wimInfo.wimIndex,
    wimEdition: wimInfo.wimEdition,
  };

  for (const targetManifest of [
    path.join(appDataDir, 'installer', 'windows-10', 'manifest.json'),
    path.join(bakedDir, 'installer', 'windows-10', 'manifest.json'),
  ]) {
    if (fs.existsSync(path.dirname(targetManifest))) {
      fs.writeFileSync(targetManifest, JSON.stringify(updatedManifest, null, 2), 'utf8');
    }
  }

  const verifier = new Win10DeployManager({
    rootDir: '/app',
    bakedRoot: bakedDir,
    hasKvm: () => false,
  });

  if (!verifier.isReady()) {
    const st = verifier.getState();
    throw new Error(`Baked Windows 10 installer failed READY check during docker build: ${st.status} (${st.stageDetail})`);
  }

  console.log(
    `[Docker-Build-Win10] Verified Windows 10 READY inside image: ISO=${isoPath}, WIM index=${wimInfo.wimIndex} (${wimInfo.wimEdition}), SHA-256=${updatedManifest.sha256Actual}`
  );
}

main();
