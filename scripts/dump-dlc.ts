/**
 * 一次性脚本:把 lib/scenarios/starmail 的 STARMAIL 常量序列化成 public/dlc/starmail.json,
 * 并生成 public/dlc/manifest.json。
 *
 * 这个脚本只在 DLC 化改造时跑一次,跑完就可以删 lib/scenarios/starmail/ 目录。
 * 以后改 starmail 数据 → 直接编辑 public/dlc/starmail.json,不再需要这个脚本。
 *
 * 用法:
 *   npx tsx scripts/dump-dlc.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { STARMAIL } from '../lib/scenarios/starmail';

const PROJECT_ROOT = resolve(__dirname, '..');
const DLC_DIR = resolve(PROJECT_ROOT, 'public', 'dlc');

interface DlcManifest {
  /** 版本号 — 改了任何 DLC 数据都该 ++,sessionStorage 缓存以这个作 cache-buster */
  version: number;
  scenarios: Array<{
    id: string;
    /** 相对于 public 根目录的路径 — fetch 时 prefix '/' */
    url: string;
    /** 元信息用于 UI 列表初步显示(不需要 fetch 整个 JSON) */
    name: string;
    shortName: string;
    description: string;
  }>;
}

function dumpScenario(s: typeof STARMAIL): string {
  // 直接 JSON.stringify;Scenario / Scene / Beat / CharacterSpec 都是纯数据结构
  return JSON.stringify(s, null, 2);
}

function main() {
  // 1) 写 starmail.json
  const starmailJson = dumpScenario(STARMAIL);
  const starmailPath = resolve(DLC_DIR, 'starmail.json');
  writeFileSync(starmailPath, starmailJson + '\n', 'utf-8');
  console.log(`✓ wrote ${starmailPath} (${starmailJson.length} bytes)`);

  // 2) 写 manifest.json
  const manifest: DlcManifest = {
    version: 1,
    scenarios: [
      {
        id: STARMAIL.id,
        url: '/dlc/starmail.json',
        name: STARMAIL.name,
        shortName: STARMAIL.shortName,
        description: STARMAIL.description,
      },
    ],
  };
  const manifestPath = resolve(DLC_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`✓ wrote ${manifestPath}`);
  console.log('\nNext steps:');
  console.log('  1. 改造 lib/scenarios/index.ts 走 DLC registry');
  console.log('  2. 删除 lib/scenarios/starmail/ 目录');
  console.log('  3. 改造 app/page.tsx 顶层加 dlcReady loading');
}

main();
