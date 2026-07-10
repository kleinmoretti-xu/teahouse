import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_ROOTS = ['App.vue', 'SettingsApp.vue', 'CaptureApp.vue', 'ImageViewerApp.vue']
const DEFAULT_MAX_BOOTSTRAP_BYTES = 200 * 1024

function sourceBaseName(key, item) {
  const source = String(item?.src ?? key).replace(/\\/g, '/')
  const parts = source.split('/')
  return parts[parts.length - 1]
}

function readManifest(path, errors) {
  if (!existsSync(path)) {
    errors.push(`${path} manifest.json 不存在`)
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('renderer manifest 必须是对象')
      return null
    }
    return parsed
  } catch (error) {
    errors.push(`renderer manifest 无法读取：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function collectStaticClosure(manifest, entryKey, errors) {
  const visited = new Set()
  const pending = [entryKey]

  while (pending.length > 0) {
    const key = pending.pop()
    if (visited.has(key)) continue
    visited.add(key)
    const item = manifest[key]
    if (!item) {
      errors.push(`manifest 静态依赖 ${key} 缺少记录`)
      continue
    }
    for (const imported of item.imports ?? []) pending.push(imported)
  }
  return visited
}

function collectReachableDynamicEntries(manifest, staticClosure) {
  const dynamic = new Set()
  for (const key of staticClosure) {
    const item = manifest[key]
    for (const imported of item?.dynamicImports ?? []) dynamic.add(imported)
  }
  return dynamic
}

function fileSize(outDir, file, errors) {
  if (typeof file !== 'string' || file.length === 0) {
    errors.push('manifest 条目缺少输出文件名')
    return 0
  }
  const path = resolve(outDir, file)
  if (!existsSync(path)) {
    errors.push(`renderer 输出文件 ${file} 不存在`)
    return 0
  }
  return statSync(path).size
}

export function checkRendererBundles({
  outDir = resolve(process.cwd(), 'out/renderer'),
  maxBootstrapBytes = DEFAULT_MAX_BOOTSTRAP_BYTES
} = {}) {
  const errors = []
  const manifest = readManifest(resolve(outDir, '.vite/manifest.json'), errors)
  if (!manifest) return { errors, bootstrapBytes: 0 }

  const entryKeys = Object.entries(manifest)
    .filter(([, item]) => item?.isEntry === true)
    .map(([key]) => key)
  if (entryKeys.length !== 1) {
    errors.push(`renderer manifest 必须且只能包含一个公共入口，当前为 ${entryKeys.length} 个`)
    return { errors, bootstrapBytes: 0 }
  }

  const staticClosure = collectStaticClosure(manifest, entryKeys[0], errors)
  const reachableDynamic = collectReachableDynamicEntries(manifest, staticClosure)
  const rootEntries = new Map()

  for (const rootName of REQUIRED_ROOTS) {
    const matches = Object.entries(manifest)
      .filter(([key, item]) => sourceBaseName(key, item) === rootName)
    if (matches.length !== 1) {
      errors.push(`${rootName} 必须且只能有一个 manifest 动态入口，当前为 ${matches.length} 个`)
      continue
    }
    const [key, item] = matches[0]
    rootEntries.set(rootName, { key, item })
    if (item.isDynamicEntry !== true) errors.push(`${rootName} 未标记为动态入口`)
    if (!reachableDynamic.has(key)) errors.push(`${rootName} 动态入口从公共入口不可达`)
    fileSize(outDir, item.file, errors)
  }

  const rootFiles = [...rootEntries.values()]
    .map(({ item }) => item.file)
    .filter((file) => typeof file === 'string' && file.length > 0)
  if (rootFiles.length === REQUIRED_ROOTS.length && new Set(rootFiles).size !== rootFiles.length) {
    errors.push('四个根组件的输出文件必须互异')
  }

  const countedFiles = new Set()
  let bootstrapBytes = 0
  for (const key of staticClosure) {
    const item = manifest[key]
    if (!item || typeof item.file !== 'string' || !item.file.endsWith('.js')) continue
    if (countedFiles.has(item.file)) continue
    countedFiles.add(item.file)
    bootstrapBytes += fileSize(outDir, item.file, errors)
  }
  if (bootstrapBytes > maxBootstrapBytes) {
    errors.push(`renderer 公共启动闭包 ${bootstrapBytes} 字节，超过 ${maxBootstrapBytes} 字节预算`)
  }

  return { errors, bootstrapBytes }
}

function main() {
  const result = checkRendererBundles()
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[renderer-bundles] ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`[renderer-bundles] 四入口检查通过，公共启动闭包 ${result.bootstrapBytes} 字节`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
