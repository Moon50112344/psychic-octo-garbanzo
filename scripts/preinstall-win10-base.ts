import path from 'node:path';
import { win10DeployManager } from '../src/server/win10DeployManager';
import { win10BasePreinstaller } from '../src/server/win10BasePreinstaller';

async function main() {
  console.log('[Docker-Build-Win10] Verifying prepared Windows 10 installer manifest...');
  const deployState = await win10DeployManager.startBackgroundPreparation();
  if (!deployState.ready || deployState.status !== 'READY') {
    throw new Error(`Windows 10 installer not READY: ${deployState.status} (${deployState.error || deployState.stageDetail})`);
  }

  console.log(`[Docker-Build-Win10] Installer READY (${deployState.isoPath}). Pre-installing base QCOW2 image...`);
  const result = await win10BasePreinstaller.runStartupPreinstallIfEligible({
    isoPath: deployState.isoPath,
    wimIndex: deployState.wimIndex,
    ramAllowed: true,
    cpuThrottled: false,
  });

  if (!result.ready) {
    throw new Error(`Base pre-install did not reach READY (${result.status}): ${result.error || result.message}`);
  }
  console.log(`[Docker-Build-Win10] Pre-installed base QCOW2 ready at ${path.resolve(result.baseDiskPath)} (${result.sizeBytes} bytes).`);
}

main().catch((err) => {
  console.error('[Docker-Build-Win10] Fatal error:', err);
  process.exit(1);
});
