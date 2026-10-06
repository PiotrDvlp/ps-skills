import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const makeRepo = (id = 'demo-check') => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prove ui repo-')))
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q')
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n.distro/\n')
  fs.writeFileSync(path.join(root, 'app.css'), 'a { color: red }\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const checkPath = path.join(root, '.claude', 'prove-ui', 'checks', `${id}.mjs`)
  fs.mkdirSync(path.dirname(checkPath), { recursive: true })
  fs.writeFileSync(checkPath, 'export default async () => {}\n')
  let runs = 0
  const shot = async (name) => {
    runs += 1
    const p = path.join(root, '.distro', 'browser', `run-${runs}`, `${name}.png`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'png')
    return p
  }
  const edit = () => fs.appendFileSync(path.join(root, 'app.css'), 'a { outline: revert }\n')
  return { root, id, checkPath, file: pathToFileURL(checkPath).href, shot, edit }
}
