#!/usr/bin/env node
/*
 * AXOL - Modpack para otros launchers (packwiz)
 * ---------------------------------------------
 * Convierte distribution.json al formato packwiz, para que los jugadores que
 * usan Prism Launcher / MultiMC reciban los mismos mods y archivos que AXOL,
 * y se les actualicen solos cada vez que abren el juego.
 *
 *  - No descarga ni sube los mods otra vez: usa las mismas URLs y MD5 que
 *    distribution.json (Release de GitHub y GitHub Pages).
 *  - Los archivos que en servermeta.json están en "untrackedFiles" (teclas,
 *    configs del jugador...) se marcan "preserve": se bajan solo la primera vez.
 *  - Genera además una instancia .zip para importar en Prism Launcher.
 *
 * Resultado (dentro del repo, se publica en GitHub Pages):
 *   packwiz/<id-modpack>/pack.toml           <- el enlace del modpack
 *   packwiz/<id-modpack>/index.toml + *.pw.toml
 *   packwiz/<id-modpack>/<Nombre>-Prism.zip  <- lo que descargan los jugadores
 *
 * Lo ejecuta publicar-mods.js automáticamente. También se puede correr solo:
 *   node generar-packwiz.js      (usa el .env de Nebula)
 */
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const BOOTSTRAP = 'packwiz-installer-bootstrap.jar'
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const q = s => JSON.stringify(String(s)) // cadena TOML básica (mismos escapes que JSON)

// --- untrackedFiles (subconjunto de minimatch suficiente para Nebula) --------
function globToRegex(glob) {
    let re = ''
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++
                if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
            } else re += '[^/]*'
        } else if (c === '?') re += '[^/]'
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp('^' + re + '$', 'i')
}

function loadPreserve(root, serverId) {
    const regs = []
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, 'servers', serverId, 'servermeta.json'), 'utf8').replace(/^﻿/, ''))
        for (const u of meta.untrackedFiles || []) {
            if (u.appliesTo && !u.appliesTo.includes('files')) continue
            for (const p of u.patterns || []) regs.push(globToRegex(p.replace(/\\/g, '/')))
        }
    } catch { /* sin servermeta: nada se preserva */ }
    return rel => regs.some(r => r.test(rel))
}

// --- Zip mínimo (sin compresión) -------------------------------------------
const CRC = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
    return buf => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
})()
function makeZip(entries) { // [{name, data:Buffer}]
    const locals = [], centrals = []
    let off = 0
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8')
        const crc = CRC(e.data)
        const lh = Buffer.alloc(30)
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8)
        lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22)
        lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
        const ch = Buffer.alloc(46)
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10)
        ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24)
        ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42)
        locals.push(lh, name, e.data); centrals.push(ch, name)
        off += 30 + name.length + e.data.length
    }
    const cd = Buffer.concat(centrals)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
    return Buffer.concat([...locals, cd, end])
}

// --- Generación -------------------------------------------------------------
function walk(list, fn) { for (const m of list || []) { fn(m); walk(m.subModules, fn) } }

function modFileName(url) {
    let n = decodeURIComponent(url.split('?')[0].split('/').pop())
    const m = n.match(/--(required|optionalon|optionaloff)--(.+)$/i)
    return { file: m ? m[2] : n, kind: m ? m[1].toLowerCase() : 'required' }
}

function safeSlug(s) { return s.replace(/\.jar$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) }

function generateServer(root, baseUrl, serv) {
    const outDir = path.join(root, 'packwiz', serv.id)
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    const isPreserved = loadPreserve(root, serv.id)

    let fabric = null
    const files = [] // { meta: relPath of .pw.toml, content, preserve }
    const used = new Set()
    let mods = 0, other = 0, kept = 0

    walk(serv.modules, m => {
        if (m.type === 'Fabric') { const v = (m.id || '').split(':')[2]; if (v) fabric = v; return }
        const a = m.artifact
        if (!a || !a.url) return
        let md5 = a.MD5 ? a.MD5.toLowerCase() : null
        let rel, side = 'client', option = null, untracked = false
        if (m.type === 'FabricMod' || m.type === 'ForgeMod') {
            const { file, kind } = modFileName(a.url)
            let slug = safeSlug(file), i = 2
            while (used.has('mods/' + slug)) slug = safeSlug(file) + '_' + i++
            used.add('mods/' + slug)
            rel = { meta: `mods/${slug}.pw.toml`, filename: file }
            side = 'both'
            if (kind !== 'required') option = { def: kind === 'optionalon' }
            mods++
        } else if (m.type === 'File' && a.path) {
            const p = a.path.replace(/\\/g, '/')
            rel = { meta: p + '.pw.toml', filename: p.split('/').pop(), path: p }
            if (!md5) {
                // Nebula no pone MD5 a los archivos "untrackedFiles": se calcula del archivo local
                const local = path.join(root, 'servers', serv.id, 'files', ...p.split('/'))
                if (!fs.existsSync(local)) return
                md5 = crypto.createHash('md5').update(fs.readFileSync(local)).digest('hex')
                untracked = true
            }
            other++
        } else return
        if (!md5) return

        const lines = [
            `name = ${q(m.name || rel.filename)}`,
            `filename = ${q(rel.filename)}`,
            `side = ${q(side)}`,
            '',
            '[download]',
            `url = ${q(a.url)}`,
            'hash-format = "md5"',
            `hash = ${q(md5)}`,
        ]
        if (option) lines.push('', '[option]', 'optional = true', `default = ${option.def}`)
        const preserve = untracked || !!(rel.path && isPreserved(rel.path))
        if (preserve) kept++
        files.push({ meta: rel.meta, content: lines.join('\n') + '\n', preserve })
    })

    if (!mods) return null

    // .pw.toml + index.toml
    const index = ['hash-format = "sha256"', '']
    for (const f of files.sort((x, y) => x.meta.localeCompare(y.meta))) {
        const dest = path.join(outDir, ...f.meta.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        const buf = Buffer.from(f.content, 'utf8')
        fs.writeFileSync(dest, buf)
        index.push('[[files]]', `file = ${q(f.meta)}`, `hash = ${q(sha256(buf))}`, 'metafile = true')
        if (f.preserve) index.push('preserve = true')
        index.push('')
    }
    const indexBuf = Buffer.from(index.join('\n'), 'utf8')
    fs.writeFileSync(path.join(outDir, 'index.toml'), indexBuf)

    const mc = serv.minecraftVersion || '1.21.1'
    const pack = [
        `name = ${q(serv.name || serv.id)}`,
        'author = "Axol Studio"',
        `version = ${q(serv.version || '1.0.0')}`,
        'pack-format = "packwiz:1.1.0"',
        '',
        '[index]',
        'file = "index.toml"',
        'hash-format = "sha256"',
        `hash = ${q(sha256(indexBuf))}`,
        '',
        '[versions]',
        `minecraft = ${q(mc)}`,
    ]
    if (fabric) pack.push(`fabric = ${q(fabric)}`)
    fs.writeFileSync(path.join(outDir, 'pack.toml'), pack.join('\n') + '\n')

    // Instancia para Prism Launcher / MultiMC
    const packUrl = `${baseUrl}packwiz/${encodeURIComponent(serv.id)}/pack.toml`
    const ram = (serv.javaOptions && serv.javaOptions.ram) || {}
    const bootstrap = path.join(__dirname, BOOTSTRAP)
    let zipName = null
    if (fs.existsSync(bootstrap)) {
        const instName = serv.name || serv.id
        const cfg = [
            'InstanceType=OneSix',
            `name=${instName}`,
            'iconKey=default',
            'OverrideCommands=true',
            `PreLaunchCommand="$INST_JAVA" -jar ${BOOTSTRAP} ${packUrl}`,
            'OverrideMemory=true',
            `MinMemAlloc=${ram.minimum || 4096}`,
            `MaxMemAlloc=${ram.recommended || 6144}`,
            '',
        ].join('\n')
        const comps = [
            { uid: 'net.minecraft', version: mc, important: true },
            { uid: 'net.fabricmc.intermediary', version: mc, dependencyOnly: true },
        ]
        if (fabric) comps.push({ uid: 'net.fabricmc.fabric-loader', version: fabric })
        const mmc = JSON.stringify({ components: comps, formatVersion: 1 }, null, 2)
        const folder = safeSlug(instName.replace(/\s+/g, '-'))
        const zip = makeZip([
            { name: `${folder}/instance.cfg`, data: Buffer.from(cfg, 'utf8') },
            { name: `${folder}/mmc-pack.json`, data: Buffer.from(mmc, 'utf8') },
            { name: `${folder}/.minecraft/${BOOTSTRAP}`, data: fs.readFileSync(bootstrap) },
        ])
        zipName = `${folder}-Prism.zip`
        fs.writeFileSync(path.join(outDir, zipName), zip)
    }
    return { id: serv.id, mods, other, kept, packUrl, zipUrl: zipName ? `${baseUrl}packwiz/${encodeURIComponent(serv.id)}/${encodeURIComponent(zipName)}` : null }
}

function generate({ root, dist, baseUrl, log = console.log }) {
    if (!baseUrl.endsWith('/')) baseUrl += '/'
    const results = []
    const keep = new Set()
    for (const serv of dist.servers || []) {
        try {
            const r = generateServer(root, baseUrl, serv)
            if (r) { results.push(r); keep.add(serv.id) }
        } catch (e) { log(`    packwiz: error con ${serv.id}: ${e.message}`) }
    }
    // Borrar modpacks que ya no existen
    const pw = path.join(root, 'packwiz')
    if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw)) if (!keep.has(d)) fs.rmSync(path.join(pw, d), { recursive: true, force: true })
    for (const r of results) {
        log(`    ${r.id}: ${r.mods} mods, ${r.other} archivos (${r.kept} se conservan del jugador)`)
        if (r.zipUrl) log(`      Instancia para Prism: ${r.zipUrl}`)
        else log(`      (falta ${BOOTSTRAP} junto a generar-packwiz.js: no se creó el .zip)`)
    }
    // Página simple con los enlaces
    if (results.length) {
        const html = `<!doctype html><meta charset="utf-8"><title>Modpacks Axol</title>
<style>body{font-family:system-ui,sans-serif;background:#141018;color:#eee;max-width:640px;margin:40px auto;padding:0 16px}a{color:#f6a957}code{background:#2a2430;padding:2px 6px;border-radius:4px;word-break:break-all}</style>
<h1>Modpacks de Axol Studio</h1>
<p>Para jugar con Prism Launcher: descarga el .zip, arrástralo a la ventana de Prism Launcher y pulsa <b>Iniciar</b>. Los mods se descargan y se actualizan solos cada vez que abres el juego.</p>
${results.map(r => `<h2>${r.id}</h2>${r.zipUrl ? `<p><a href="${r.zipUrl}">Descargar instancia (.zip)</a></p>` : ''}<p>Enlace packwiz: <code>${r.packUrl}</code></p>`).join('\n')}
`
        fs.writeFileSync(path.join(pw, 'index.html'), html)
    }
    return results
}

module.exports = { generate }

if (require.main === module) {
    const readEnv = file => {
        const out = {}
        try {
            for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
                const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
                if (m) out[m[1]] = m[2].replace(/^"|"$/g, '')
            }
        } catch { /* sin .env */ }
        return out
    }
    const env = readEnv(path.join(process.env.NEBULA_DIR || '', '.env'))
    const root = env.ROOT || __dirname
    const baseUrl = env.BASE_URL || process.argv[2]
    if (!baseUrl) { console.log('No encuentro BASE_URL. Ejecútalo con publicar.bat o pasa la URL: node generar-packwiz.js https://USUARIO.github.io/voragos-repo/'); process.exit(1) }
    const dist = JSON.parse(fs.readFileSync(path.join(root, 'distribution.json'), 'utf8').replace(/^﻿/, ''))
    console.log('Generando modpack packwiz...')
    generate({ root, dist, baseUrl })
}
