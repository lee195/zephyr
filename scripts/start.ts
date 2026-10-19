import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

function newestMtime(path: string): number {
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  return Math.max(st.mtimeMs, ...readdirSync(path).map((n) => newestMtime(join(path, n))))
}

const built = (() => {
  try {
    return statSync(join(root, 'viewer/dist/index.html')).mtimeMs
  } catch {
    return 0
  }
})()
const sources = Math.max(newestMtime(join(root, 'viewer/src')), newestMtime(join(root, 'viewer/index.html')))

if (sources > built) {
  console.log('[zephyr] building viewer')
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

await import('../src/main')
