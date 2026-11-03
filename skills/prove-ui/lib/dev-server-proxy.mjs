/**
 * Preloaded into `browser --serve`'s dev server. Vite's server.proxy (http-proxy) sends every request
 * with `agent: false`, a one-off agent that ignores NODE_USE_ENV_PROXY, so inside the sandbox it
 * resolves DNS directly and fails ENOTFOUND. Such requests get the env-proxy-aware global agent, and
 * the `Connection: close` http-proxy adds for agentless requests is dropped: through the env proxy a
 * server-closed response sometimes ends in `close` without `end`, truncating silently and leaving the
 * browser waiting (measured 2026-09-25, Node 22.21.1: 19 of 216 downloads truncated with close, 0 of 216 without).
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

const LOG = process.env.BROWSER_PROXY_LOG
const log = (line) => LOG && fs.appendFileSync(LOG, `${((performance.now() / 1000) | 0).toString().padStart(4)}s ${line}\n`)
const VITE_DIST = ['node_modules', 'vite', 'dist', ''].join(path.sep)
let seq = 0

const calledFromVite = (fn) => {
  const holder = {}
  Error.captureStackTrace(holder, fn)
  return (holder.stack.split('\n')[1] ?? '').includes(VITE_DIST)
}

for (const mod of [http, https]) {
  const request = mod.request
  mod.request = function patched(...args) {
    const options = args.find((a) => a !== null && typeof a === 'object' && !(a instanceof URL))
    if (options?.agent !== false || !calledFromVite(patched)) return request.apply(this, args)
    options.agent = mod.globalAgent
    for (const k of Object.keys(options.headers ?? {})) if (k.toLowerCase() === 'connection' && String(options.headers[k]).toLowerCase() === 'close') delete options.headers[k]
    const id = ++seq
    const req = request.apply(this, args)
    log(`#${id} start ${options.method ?? 'GET'} ${options.host ?? options.hostname}${options.path ?? ''}`)
    req.on('socket', () => log(`#${id} socket`))
    req.on('response', (res) => {
      log(`#${id} response ${res.statusCode}`)
      res.on('end', () => log(`#${id} end`))
    })
    req.on('error', (e) => log(`#${id} error ${e.code ?? e.message}`))
    req.on('close', () => log(`#${id} close`))
    return req
  }
}
