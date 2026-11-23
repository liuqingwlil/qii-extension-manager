import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const release = resolve(root, 'release');

async function requiredFile(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile())
    throw new Error(`缺少打包资源：${relative(root, path)}。请先运行 npm run build。`);
}

function inside(directory, path) {
  const rel = relative(directory, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

async function validateBuild() {
  await requiredFile(resolve(dist, 'manifest.json'));
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  const project = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.version !== project.version) {
    throw new Error('构建 manifest 版本与项目版本不一致，请重新构建。');
  }
  const resources = new Set(
    [
      'index.html',
      'popup.html',
      'background.js',
      'skins/elysia.png',
      'skins/elysia-garden.svg',
      'migration/QiiMigration.exe',
      'qii-manager.json',
      ...[16, 32, 48, 128].map((size) => `icons/icon${size}.png`),
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      manifest.options_ui?.page,
      ...Object.values(manifest.icons || {}),
      ...Object.values(manifest.action?.default_icon || {}),
    ].filter(Boolean),
  );
  for (const resource of resources) {
    const path = resolve(dist, resource);
    if (!inside(dist, path)) throw new Error(`构建资源路径无效：${resource}`);
    await requiredFile(path);
  }
  for (const html of ['index.html', 'popup.html']) {
    const text = await readFile(resolve(dist, html), 'utf8');
    for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const ref = match[1];
      if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) continue;
      const cleanRef = decodeURIComponent(ref.split(/[?#]/)[0]);
      if (!cleanRef) continue;
      const path = resolve(dist, cleanRef.replace(/^\//, ''));
      if (!inside(dist, path)) throw new Error(`HTML 资源路径越界：${ref}`);
      await requiredFile(path);
    }
  }
  return manifest.version;
}

async function collect(directory, prefix = '', excluded = new Set()) {
  const files = {};
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (excluded.has(entry.name) || entry.name.startsWith('.env') || entry.name.endsWith('.log'))
      continue;
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    const zipPath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, await collect(path, `${zipPath}/`, excluded));
    else if (entry.isFile()) files[zipPath] = new Uint8Array(await readFile(path));
  }
  return files;
}

try {
  const version = await validateBuild();
  await mkdir(release, { recursive: true });
  const installPath = resolve(release, `qii-extension-manager-${version}.zip`);
  const sourcePath = resolve(release, `qii-extension-manager-${version}-source.zip`);
  const builtFiles = await collect(dist);
  if (!builtFiles['manifest.json']) throw new Error('安装包 manifest.json 必须位于压缩包根目录。');
  await writeFile(installPath, zipSync(builtFiles, { level: 9 }));
  const ignored = new Set([
    'node_modules',
    'build',
    'dist',
    'release',
    'test-results',
    'work',
    '.git',
    '.DS_Store',
    'Thumbs.db',
    '__pycache__',
    '.pytest_cache',
  ]);
  const sourceFiles = await collect(root, 'qii-extension-manager/', ignored);
  await writeFile(sourcePath, zipSync(sourceFiles, { level: 9 }));
  console.log(`安装包：${installPath}（${Object.keys(builtFiles).length} 个文件）`);
  console.log(`源码包：${sourcePath}（${Object.keys(sourceFiles).length} 个文件）`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
