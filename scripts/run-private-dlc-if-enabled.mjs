import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const script = 'scripts/build-datang-dlc.mjs';
const enabled = process.env.WC_BUILD_PRIVATE_DLC === '1';

if (!enabled) {
  if (existsSync(script)) {
    console.log('[private-dlc] skipped ignored private DLC builder (set WC_BUILD_PRIVATE_DLC=1 to enable)');
  }
  process.exit(0);
}

if (!existsSync(script)) {
  console.log('[private-dlc] no private DLC builder found');
  process.exit(0);
}

const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
process.exit(result.status ?? 1);
