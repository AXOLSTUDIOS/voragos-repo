#!/usr/bin/env node
/*
 * AXOL - Verificar descargas
 * Descarga distribution.json desde GitHub Pages (lo mismo que hace el launcher)
 * y comprueba que TODOS los archivos que pide existan. Lista los que dan error.
 * Uso: node verificar-urls.js [URL de distribution.json]
 */
'use strict'
const fs = require('fs')
const path = require('path')

function readEnv(file) {
    const out = {}
    try {
        for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
            if (m) out[m[1]] = m[2].replace(/^"|"$/g, '')
        }
    } catch { /* sin .env */ }
    return out
}

function walk(list, fn) { for (const m of list || []) { fn(m); walk(m.subModules, fn) } }

async function check(url) {
    for (let i = 0; i < 3; i++) {
        try {
            let r = await fetch(url, { method: 'HEAD', redirect: 'follow' })
            if (r.status === 405 || r.status === 403) r = await fetch(url, { method: 'GET', redirect: 'follow' })
            return r.status
        } catch (e) {
            if (i === 2) return 'sin conexión: ' + e.message
        }
    }
}

async function main() {
    let url = process.argv[2]
    if (!url) {
        const env = readEnv(path.join(process.env.NEBULA_DIR || '', '.env'))
        let base = env.BASE_URL || ''
        if (base && !base.endsWith('/')) base += '/'
        url = base + 'distribution.json'
    }
    if (!/^https?:\/\//.test(url)) { console.log('Uso: node verificar-urls.js https://TU-USUARIO.github.io/voragos-repo/distribution.json'); process.exit(1) }

    console.log(`\nDescargando ${url} ...`)
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'nocache=' + Date.now())
    if (!res.ok) { console.log(`ERROR ${res.status}: no se pudo descargar distribution.json`); process.exit(1) }
    const dist = await res.json()

    const items = []
    for (const s of dist.servers || []) {
        walk(s.modules, m => { if (m.artifact && m.artifact.url) items.push({ server: s.id, name: m.name || m.id, url: m.artifact.url }) })
    }
    console.log(`Revisando ${items.length} archivos (puede tardar un minuto)...\n`)

    const bad = []
    let done = 0
    const queue = [...items]
    await Promise.all(Array.from({ length: 12 }, async () => {
        while (queue.length) {
            const it = queue.shift()
            const st = await check(it.url)
            if (st !== 200) bad.push({ ...it, st })
            done++
            if (done % 25 === 0) process.stdout.write(`  ${done}/${items.length}\n`)
        }
    }))

    const lines = []
    if (!bad.length) {
        lines.push('TODO BIEN: los ' + items.length + ' archivos existen. El launcher deberia descargar sin errores.')
    } else {
        lines.push(`${bad.length} ARCHIVO(S) CON ERROR:`, '')
        for (const b of bad) lines.push(`[${b.st}] ${b.server} - ${b.name}`, `      ${b.url}`, '')
    }
    const report = lines.join('\r\n')
    console.log('\n' + report)
    const out = path.join(__dirname, '..', 'informe-urls.txt')
    try { fs.writeFileSync(out, report, 'utf8'); console.log(`\nInforme guardado en: ${path.resolve(out)}`) } catch { /* sin permiso */ }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1) })
