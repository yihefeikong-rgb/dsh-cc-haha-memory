/**
 * dsh-memory 构建脚本:
 *  - host:src/index.ts → lib/index.js(ESM bundle,零运行时依赖)
 *  - client:src/client 入口 → .client-build/index.js(CJS,平台模块 external)
 *    → 包成 window.__ModuleLoader__.load({id, factory}) 格式 → lib/client.js
 *  - esbuild 为 devDependency(本地 pnpm add -D esbuild)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

// 与 dsh client 平台模块表对齐(参考 dsh-memory-evolve build.mjs 的 EXTERNALS)
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-runtime',
]

const esbuild = require('esbuild')

// ── host bundle ────────────────────────────────────────────────────────────
await esbuild.build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(ROOT, 'lib/index.js'),
  sourcemap: true,
  logLevel: 'warning',
  // DSH 宿主服务由 ~/.dsh/node_modules 链接层提供，避免打包第二份协议类型。
  external: ['@deepseek-ai/schemastery'],
})

// ── client bundle ──────────────────────────────────────────────────────────
await esbuild.build({
  entryPoints: [join(ROOT, 'client/src/index.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  jsx: 'automatic',
  outfile: join(ROOT, '.client-build/index.js'),
  external: EXTERNALS,
  sourcemap: true,
  logLevel: 'warning',
})

// ── wrap client into loader format ─────────────────────────────────────────
const built = join(ROOT, '.client-build/index.js')
const builtMap = join(ROOT, '.client-build/index.js.map')
const libDir = join(ROOT, 'lib')
const source = (await readFile(built, 'utf8')).replace(/\n?\/\/# sourceMappingURL=.*\n?$/, '\n')
let sourceMap = null
try {
  sourceMap = JSON.parse(await readFile(builtMap, 'utf8'))
  sourceMap.file = 'client.js'
  sourceMap.sources = sourceMap.sources.map((p) => `../client/src/${p.replace(/^\.\.\//, '').replace(/^\.\//, '')}`)
} catch { /* map 可选 */ }

// loader entry 的 id 必须与 package.json name 完全一致
const banner = `window.__ModuleLoader__.load({ id: "${MANIFEST.name}", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n`
const footer = '\nreturn module.exports; } });\n' + (sourceMap ? '//# sourceMappingURL=client.js.map\n' : '')

await mkdir(libDir, { recursive: true })
await writeFile(join(libDir, 'client.js'), `${banner}${source}${footer}`)
if (sourceMap) await writeFile(join(libDir, 'client.js.map'), `${JSON.stringify(sourceMap)}\n`)
await rm(join(ROOT, '.client-build'), { recursive: true, force: true })

console.log('[dsh-memory] build OK → lib/index.js + lib/client.js')
