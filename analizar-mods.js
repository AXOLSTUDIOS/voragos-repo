#!/usr/bin/env node
/*
 * AXOL - Analizador de mods de Fabric
 * -----------------------------------
 * Lee el fabric.mod.json de cada .jar (incluidos los jars que vienen dentro
 * de otros) y detecta:
 *   1. Librerías que ningún mod necesita        -> se pueden quitar
 *   2. Mods que solo sirven en el SERVIDOR        -> los jugadores no los necesitan
 *   3. Mods repetidos (mismo mod en dos versiones)
 *   4. Dependencias que FALTAN (un mod pide algo que no está)
 *   5. Archivos que no son mods de Fabric
 *   6. Los archivos que más pesan
 * Al final pregunta si quieres MOVER (no borrar) los sobrantes a otra carpeta.
 * Escribe todo en informe-mods.txt.
 *
 * Uso: node analizar-mods.js "F:\ruta\a\la\carpeta\mods"
 */
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const readline = require('readline')

// ---------------------------------------------------------------------------
// Lector mínimo de .zip / .jar (sin librerías externas)
// ---------------------------------------------------------------------------
function readZip(buf) {
    const min = Math.max(0, buf.length - 65557)
    let eocd = -1
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('no es un zip válido')
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    const entries = new Map()
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break
        const method = buf.readUInt16LE(p + 10)
        const csize = buf.readUInt32LE(p + 20)
        const nlen = buf.readUInt16LE(p + 28)
        const elen = buf.readUInt16LE(p + 30)
        const clen = buf.readUInt16LE(p + 32)
        const off = buf.readUInt32LE(p + 42)
        const name = buf.toString('utf8', p + 46, p + 46 + nlen)
        entries.set(name, { method, csize, off })
        p += 46 + nlen + elen + clen
    }
    return {
        has: name => entries.has(name),
        names: () => [...entries.keys()],
        read(name) {
            const e = entries.get(name)
            if (!e) return null
            const lnl = buf.readUInt16LE(e.off + 26)
            const lel = buf.readUInt16LE(e.off + 28)
            const start = e.off + 30 + lnl + lel
            const data = buf.subarray(start, start + e.csize)
            if (e.method === 0) return data
            if (e.method === 8) return zlib.inflateRawSync(data)
            throw new Error(`compresión ${e.method} no soportada`)
        }
    }
}

function parseLenient(text) {
    text = text.replace(/^\uFEFF/, '')
    try { return JSON.parse(text) } catch { /* sigue */ }
    let t = text.replace(/[\u0000-\u001f]+/g, ' ')
    try { return JSON.parse(t) } catch { /* sigue */ }
    t = t.replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(t)
}

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v])

// Lee la información de un jar (y de sus jars internos).
function inspectJar(buf, depth = 0) {
    const zip = readZip(buf)
    const raw = zip.read('fabric.mod.json')
    if (!raw) {
        let kind = 'no es un mod de Fabric'
        if (zip.has('quilt.mod.json')) kind = 'mod de Quilt'
        else if (zip.has('META-INF/neoforge.mods.toml')) kind = 'mod de NeoForge'
        else if (zip.has('META-INF/mods.toml') || zip.has('mcmod.info')) kind = 'mod de Forge'
        return { fabric: false, kind }
    }
    const j = parseLenient(raw.toString('utf8'))
    const info = {
        fabric: true,
        id: String(j.id || '').toLowerCase(),
        name: j.name || j.id || '',
        version: String(j.version || ''),
        environment: j.environment || '*',
        depends: Object.keys(j.depends || {}).map(s => s.toLowerCase()),
        dependsRaw: j.depends || {},
        soft: [...Object.keys(j.recommends || {}), ...Object.keys(j.suggests || {})].map(s => s.toLowerCase()),
        provides: asList(j.provides).map(s => String(s).toLowerCase()),
        badges: asList(j.custom && j.custom.modmenu && j.custom.modmenu.badges).map(String),
        nestedIds: []
    }
    if (depth < 4) {
        for (const ref of asList(j.jars)) {
            const file = ref && ref.file
            if (!file) continue
            try {
                const inner = zip.read(file)
                if (!inner) continue
                const ni = inspectJar(inner, depth + 1)
                if (ni.fabric) info.nestedIds.push(ni.id, ...ni.provides, ...ni.nestedIds)
            } catch { /* jar interno ilegible: se ignora */ }
        }
    }
    return info
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras'])
const LIB_ID = /(^|[-_])(lib|libs|library|api|core|config|framework|compat|base|common)([-_]|$)|lib$|^lib|api$/i
const LIB_NAME = /\b(lib|library|api|core|config|framework|compat)\b|lib\b/i

function isLibrary(m) {
    return m.badges.includes('library') || LIB_ID.test(m.id) || LIB_NAME.test(m.name)
}

const mb = n => (n / 1048576).toFixed(1) + ' MB'

// ---------------------------------------------------------------------------
async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = q => new Promise(r => rl.question(q, a => r(a.trim())))

    let dir = process.argv[2]
    if (!dir) {
        const drive = path.parse(__dirname).root
        const def = path.join(drive, 'AxolDev', 'voragos-repo', 'servers', 'voragos-2-1.21.1', 'fabricmods', 'required')
        const ans = await ask(`Carpeta de mods a analizar${fs.existsSync(def) ? ` [Enter = ${def}]` : ''}: `)
        dir = ans || def
    }
    dir = dir.replace(/^"|"$/g, '')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.log(`\nNo existe la carpeta: ${dir}`)
        rl.close(); process.exitCode = 1; return
    }

    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar'))
    console.log(`\nAnalizando ${files.length} archivos .jar en:\n  ${dir}\n`)

    const mods = []
    const broken = []
    const foreign = []
    for (const f of files) {
        const full = path.join(dir, f)
        const size = fs.statSync(full).size
        try {
            const info = inspectJar(fs.readFileSync(full))
            if (!info.fabric) { foreign.push({ file: f, size, kind: info.kind }); continue }
            mods.push({ ...info, file: f, size })
        } catch (e) {
            broken.push({ file: f, size, error: e.message })
        }
    }

    // Quién aporta cada id
    const supplies = m => new Set([m.id, ...m.provides, ...m.nestedIds])
    const supplierOf = id => mods.filter(m => supplies(m).has(id))

    // Duplicados
    const byId = new Map()
    for (const m of mods) byId.set(m.id, [...(byId.get(m.id) || []), m])
    const dups = [...byId.values()].filter(l => l.length > 1)

    // Faltantes
    const missing = []
    for (const m of mods) {
        for (const d of m.depends) {
            if (BUILTIN.has(d)) continue
            if (supplierOf(d).length === 0) missing.push({ mod: m, dep: d, ver: m.dependsRaw[d] })
        }
    }

    // Solo servidor
    const serverOnly = mods.filter(m => m.environment === 'server')

    // Librerías sin uso (se repite hasta estabilizar: quitar una puede dejar otra sin uso)
    const removed = new Set(serverOnly)
    let changed = true
    const orphans = []
    while (changed) {
        changed = false
        for (const m of mods) {
            if (removed.has(m) || !isLibrary(m)) continue
            const ids = supplies(m)
            const usedBy = mods.filter(o => o !== m && !removed.has(o) &&
                (o.depends.some(d => ids.has(d)) || o.soft.some(d => ids.has(d))))
            if (usedBy.length === 0) { orphans.push(m); removed.add(m); changed = true }
        }
    }

    // Informe
    const total = [...mods, ...foreign, ...broken].reduce((a, m) => a + m.size, 0)
    const L = []
    const h = t => { L.push('', t, '-'.repeat(t.length)) }
    L.push('INFORME DE MODS - AXOL', `Carpeta: ${dir}`, `Fecha: ${new Date().toLocaleString()}`,
        `Archivos .jar: ${files.length}   Mods de Fabric: ${mods.length}   Peso total: ${mb(total)}`)

    h(`1. LIBRERIAS QUE NINGUN MOD USA (${orphans.length}) -> se pueden quitar`)
    orphans.forEach(m => L.push(`  - ${m.file}  (${m.name}, ${mb(m.size)})`))
    if (!orphans.length) L.push('  Ninguna.')

    h(`2. MODS SOLO DE SERVIDOR (${serverOnly.length}) -> los jugadores no los necesitan`)
    serverOnly.forEach(m => L.push(`  - ${m.file}  (${m.name}, ${mb(m.size)})`))
    if (!serverOnly.length) L.push('  Ninguno.')

    h(`3. MODS REPETIDOS (${dups.length}) -> deja solo la version mas nueva`)
    dups.forEach(l => L.push(`  - ${l[0].name}: ` + l.map(m => `${m.file} (v${m.version})`).join('  |  ')))
    if (!dups.length) L.push('  Ninguno.')

    h(`4. DEPENDENCIAS QUE FALTAN (${missing.length}) -> hay que AGREGARLAS o el juego no abre`)
    missing.forEach(x => L.push(`  - ${x.mod.name} (${x.mod.file}) necesita "${x.dep}" ${asList(x.ver).join(' / ')}`))
    if (!missing.length) L.push('  Ninguna. Todo lo que piden los mods esta presente.')

    h(`5. ARCHIVOS QUE NO SON MODS DE FABRIC (${foreign.length + broken.length})`)
    foreign.forEach(x => L.push(`  - ${x.file}  (${x.kind})`))
    broken.forEach(x => L.push(`  - ${x.file}  (no se pudo leer: ${x.error})`))
    if (!foreign.length && !broken.length) L.push('  Ninguno.')

    h('6. LOS 15 ARCHIVOS QUE MAS PESAN')
    ;[...mods, ...foreign].sort((a, b) => b.size - a.size).slice(0, 15)
        .forEach(m => L.push(`  ${mb(m.size).padStart(9)}  ${m.file}`))

    const big = [...mods, ...foreign].filter(m => m.size > 100 * 1048576)
    if (big.length) {
        h('ATENCION: ARCHIVOS DE MAS DE 100 MB (GitHub no los acepta)')
        big.forEach(m => L.push(`  - ${m.file} (${mb(m.size)})`))
    }

    const toMove = [...orphans, ...serverOnly, ...foreign, ...broken]
    const saved = toMove.reduce((a, m) => a + m.size, 0)
    L.push('', `Si quitas los puntos 1, 2 y 5 ahorras ${mb(saved)}.`,
        'NOTA: algunas librerias las usan datapacks o scripts (KubeJS, CraftTweaker) sin declararlo.',
        'Por eso se MUEVEN a otra carpeta en vez de borrarse: prueba el juego y, si algo falla, regresalas.')

    const report = L.join('\r\n')
    console.log(report)

    const drive = path.parse(dir).root
    const outBase = fs.existsSync(path.join(drive, 'AxolDev')) ? path.join(drive, 'AxolDev') : path.dirname(dir)
    const reportPath = path.join(outBase, 'informe-mods.txt')
    fs.writeFileSync(reportPath, report, 'utf8')
    console.log(`\nInforme guardado en: ${reportPath}`)

    if (toMove.length) {
        const a = (await ask(`\n¿Mover los ${toMove.length} archivos de los puntos 1, 2 y 5 a una carpeta aparte? (s/n): `)).toLowerCase()
        if (a === 's' || a === 'si' || a === 'sí') {
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
            const dest = path.join(outBase, 'mods-sobrantes', stamp)
            fs.mkdirSync(dest, { recursive: true })
            for (const m of toMove) {
                const from = path.join(dir, m.file), to = path.join(dest, m.file)
                try { fs.renameSync(from, to) } catch { fs.copyFileSync(from, to); fs.unlinkSync(from) }
            }
            console.log(`\nListo. Se movieron a:\n  ${dest}\nPrueba el juego. Si algo falla, regresa el archivo que haga falta.`)
            console.log('Los duplicados (punto 3) y faltantes (punto 4) revisalos a mano.')
        } else {
            console.log('\nNo se movio nada.')
        }
    }
    rl.close()
}

main().catch(e => { console.error('\nError:', e.message); process.exitCode = 1 })
