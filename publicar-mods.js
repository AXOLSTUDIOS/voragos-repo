#!/usr/bin/env node
/*
 * AXOL - Publicar modpacks
 * ------------------------
 * GitHub Pages solo admite 1 GB y archivos de hasta 100 MB. Por eso:
 *   - Los .jar de mods (y cualquier archivo de más de 50 MB) se suben a un
 *     Release de GitHub llamado "mods" (hasta 2 GB por archivo, sin límite total).
 *   - distribution.json, configs, imágenes y librerías pequeñas siguen en Pages.
 *   - En distribution.json se cambian las URLs de esos archivos para que apunten
 *     al Release. Los MD5 no cambian, así que el launcher valida igual.
 * Solo se suben los archivos nuevos o modificados, y se borran del Release los
 * que ya no usa ningún modpack.
 *
 * Lo ejecuta publicar.bat (que antes carga axol-config.bat).
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync, execSync } = require('child_process')

const TAG = 'mods'
const BIG = 50 * 1024 * 1024
const MARK_A = '# --- AXOL: archivos grandes (los maneja publicar-mods.js) ---'
const MARK_B = '# --- AXOL: fin ---'

const log = (...a) => console.log(...a)
const fail = msg => { console.error('\nERROR: ' + msg); process.exit(1) }

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}
function gh(args, opts) {
    try {
        return run('gh', args, opts)
    } catch (e) {
        const msg = (e.stderr || e.message || '').toString().trim()
        const err = new Error(msg)
        err.gh = true
        err.code = e.code
        throw err
    }
}

function readEnv(file) {
    const out = {}
    for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
        if (m) out[m[1]] = m[2].replace(/^"|"$/g, '')
    }
    return out
}

function assetName(rel) {
    // servers/voragos-2-1.21.1/fabricmods/required/sodium.jar -> voragos-2-1.21.1--fabricmods--required--sodium.jar
    return rel.replace(/^servers\//, '').split('/').join('--').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 250)
}

// Lee la URL del repositorio. Si Git bloquea la carpeta por estar en otro disco
// ("dubious ownership"), la marca como segura y vuelve a intentar.
function gitRemote(root) {
    const read = () => run('git', ['-C', root, 'config', '--get', 'remote.origin.url']).trim()
    try {
        return read()
    } catch (e) {
        const err = (e.stderr || e.message || '').toString()
        if (/dubious ownership|safe\.directory/i.test(err)) {
            log('    Git bloqueaba la carpeta por estar en otro disco. Marcándola como segura...')
            run('git', ['config', '--global', '--add', 'safe.directory', root.replace(/\\/g, '/')])
            try { return read() } catch (e2) { fail('Git sigue sin poder leer el repositorio:\n' + (e2.stderr || e2.message)) }
        }
        if (!fs.existsSync(path.join(root, '.git'))) {
            fail(`La carpeta ${root} no tiene un repositorio de Git (.git).\nBórrala y vuelve a ejecutar INSTALAR.bat para clonarla de nuevo.`)
        }
        if (!err.trim()) fail(`El repositorio ${root} no tiene configurado "origin" (la dirección de GitHub).`)
        fail('Git no pudo leer el repositorio:\n' + err.trim())
    }
}

// Se asegura de que GitHub CLI exista y tenga la sesión iniciada; si no, abre el inicio de sesión.
function findFile(dir, name, depth = 0) {
    if (depth > 4 || !fs.existsSync(dir)) return null
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name.toLowerCase() === name) return full
        if (e.isDirectory()) { const r = findFile(full, name, depth + 1); if (r) return r }
    }
    return null
}
// Cuenta activa de GitHub CLI (null si no hay sesión válida). Se usa "gh api user"
// en vez de "gh auth status" porque este último falla si CUALQUIER cuenta guardada
// tiene el token vencido, aunque la cuenta activa funcione bien.
function activeLogin() {
    try { return JSON.parse(gh(['api', 'user'])).login || null } catch { return null }
}
function ensureGhLogin(devDir, owner) {
    try {
        gh(['--version'])
    } catch (e) {
        const exe = findFile(path.join(devDir, 'tools'), process.platform === 'win32' ? 'gh.exe' : 'gh')
        if (!exe) fail('No encuentro GitHub CLI (gh). Ejecuta INSTALAR.bat otra vez.')
        process.env.PATH = path.dirname(exe) + path.delimiter + process.env.PATH
    }
    let login = activeLogin()
    if (!login) {
        log('\n============================================================')
        log(' Inicia sesión en GitHub (solo esta vez):')
        log('  1. Copia el código de 8 letras que aparece abajo.')
        log('  2. Pulsa Enter: se abre el navegador.')
        log('  3. Pega el código y autoriza "GitHub CLI".')
        log('============================================================\n')
        try {
            execFileSync('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { stdio: 'inherit' })
        } catch { fail('No se completó el inicio de sesión en GitHub. Vuelve a intentarlo.') }
        login = activeLogin()
        if (!login) fail('GitHub CLI sigue sin una sesión válida. Ejecuta "gh auth login" y vuelve a intentarlo.')
    }
    // Si el repositorio es de otra cuenta que también tienes guardada, cambia a esa.
    if (owner && login.toLowerCase() !== owner.toLowerCase()) {
        try {
            gh(['auth', 'switch', '--hostname', 'github.com', '--user', owner])
            const now = activeLogin()
            if (now) login = now
        } catch { /* puede ser una organización tuya: se intenta con la cuenta actual */ }
        if (login.toLowerCase() !== owner.toLowerCase()) {
            log(`    Aviso: el repositorio es de "${owner}" y la sesión activa es "${login}".`)
            log('    Si la subida falla por permisos, inicia sesión con la cuenta dueña del repositorio.')
        }
    }
    try { execFileSync('gh', ['auth', 'setup-git'], { stdio: 'ignore' }) } catch { /* no es crítico */ }
    log(`    Sesión de GitHub: ${login}`)
}

function walkModules(list, fn) {
    for (const m of list || []) {
        fn(m)
        walkModules(m.subModules, fn)
    }
}

function main() {
    const nebula = process.env.NEBULA_DIR
    if (!nebula || !fs.existsSync(path.join(nebula, '.env'))) fail('No encuentro Nebula. Revisa NEBULA_DIR en axol-config.bat.')
    const env = readEnv(path.join(nebula, '.env'))
    const ROOT = env.ROOT
    let BASE = env.BASE_URL || ''
    if (!BASE.endsWith('/')) BASE += '/'
    if (!ROOT || !fs.existsSync(ROOT)) fail('ROOT del .env de Nebula no existe: ' + ROOT)

    // 0. Repositorio de GitHub
    const remote = gitRemote(ROOT)
    const rm = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/i)
    if (!rm) fail('No reconozco el repositorio de GitHub: ' + remote)
    const repo = `${rm[1]}/${rm[2]}`

    ensureGhLogin(path.dirname(ROOT), rm[1])

    // 1. Nebula
    if (!process.env.AXOL_SKIP_NEBULA) {
        log('\n[1/4] Generando distribution.json con Nebula...')
        try {
            execSync('npm run start -- g distro', { cwd: nebula, stdio: 'inherit' })
        } catch { fail('Nebula falló. Revisa el mensaje de arriba. No se subió nada.') }
    }

    const distPath = path.join(ROOT, 'distribution.json')
    const dist = JSON.parse(fs.readFileSync(distPath, 'utf8').replace(/^﻿/, ''))

    // 2. Qué archivos van al Release
    const wanted = new Map()   // assetName -> { local, md5, size }
    const bigNonJar = new Set()
    for (const serv of dist.servers || []) {
        walkModules(serv.modules, m => {
            const a = m.artifact
            if (!a || !a.url || !a.url.toLowerCase().startsWith((BASE + 'servers/').toLowerCase())) return
            const rel = decodeURIComponent(a.url.slice(BASE.length))
            const local = path.join(ROOT, ...rel.split('/'))
            if (!fs.existsSync(local)) return
            const size = fs.statSync(local).size
            const isModJar = /\/(fabricmods|forgemods)\//.test(rel) && rel.toLowerCase().endsWith('.jar')
            if (!isModJar && size <= BIG) return
            if (!isModJar) bigNonJar.add(rel)
            const name = assetName(rel)
            wanted.set(name, { local, md5: a.MD5, size })
            a.url = `https://github.com/${repo}/releases/download/${TAG}/${name}`
        })
    }

    if (wanted.size === 0) {
        fail('No encontré ningún mod para subir en distribution.json.\n' +
             'Revisa que los .jar estén en servers\\<modpack>\\fabricmods\\required y que BASE_URL del .env de Nebula sea correcto.')
    }

    // 3. Release "mods"
    log(`\n[2/4] Subiendo mods al Release "${TAG}" de ${repo}...`)
    let releaseId
    try {
        releaseId = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${TAG}`])).id
    } catch {
        gh(['release', 'create', TAG, '--repo', repo, '--title', 'Archivos de los modpacks',
            '--notes', 'Archivos que descarga AXOL Launcher. Los administra publicar.bat: no los edites a mano.', '--latest=false'])
        releaseId = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${TAG}`])).id
    }
    // Lista COMPLETA de archivos del Release (paginada; "gh release view" no siempre los trae todos)
    const listAssets = () => {
        const out = gh(['api', '--paginate', `repos/${repo}/releases/${releaseId}/assets?per_page=100`, '--jq', '.[] | [.name, .size, .state] | @tsv'])
        return out.split(/\r?\n/).filter(Boolean).map(l => { const [name, size, state] = l.split('\t'); return { name, size: Number(size), state } })
    }
    const existing = listAssets()
    const remoteSize = new Map(existing.filter(a => a.state === 'uploaded').map(a => [a.name, a.size]))
    log(`    En GitHub hay ${remoteSize.size} archivo(s); el modpack necesita ${wanted.size}.`)

    const cacheDir = path.join(path.dirname(ROOT), '.cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    const manifestPath = path.join(cacheDir, `release-${rm[1]}-${rm[2]}.json`)
    let manifest = {}
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { /* primera vez */ }

    const toUpload = []
    for (const [name, f] of wanted) {
        const same = remoteSize.get(name) === f.size && (manifest[name] == null || manifest[name] === f.md5)
        if (!same) toUpload.push(name)
    }

    if (toUpload.length === 0) {
        log('    Todos los mods ya estaban subidos.')
    } else {
        const stage = path.join(cacheDir, 'subida')
        fs.rmSync(stage, { recursive: true, force: true })
        fs.mkdirSync(stage, { recursive: true })
        const totalMB = toUpload.reduce((s, n) => s + wanted.get(n).size, 0) / 1048576
        log(`    ${toUpload.length} archivo(s) nuevos o cambiados (${totalMB.toFixed(0)} MB). Puede tardar según tu internet.`)
        let done = 0
        for (let i = 0; i < toUpload.length; i += 10) {
            const chunk = toUpload.slice(i, i + 10)
            const files = chunk.map(n => {
                const dst = path.join(stage, n)
                try { fs.linkSync(wanted.get(n).local, dst) } catch { fs.copyFileSync(wanted.get(n).local, dst) }
                return dst
            })
            gh(['release', 'upload', TAG, ...files, '--repo', repo, '--clobber'], { stdio: ['ignore', 'pipe', 'inherit'] })
            for (const n of chunk) manifest[n] = wanted.get(n).md5
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
            done += chunk.length
            log(`    ${done}/${toUpload.length} subidos`)
            files.forEach(f => fs.rmSync(f, { force: true }))
        }
    }

    // Verificar que TODO quedó en GitHub; reintentar lo que falte
    for (let intento = 1; ; intento++) {
        const now = new Map(listAssets().filter(a => a.state === 'uploaded').map(a => [a.name, a.size]))
        const missing = [...wanted].filter(([n, f]) => now.get(n) !== f.size).map(([n]) => n)
        if (missing.length === 0) { log(`    Verificado: los ${wanted.size} archivos están en GitHub.`); break }
        if (intento > 3) fail(`Faltan ${missing.length} archivo(s) en GitHub después de 3 intentos, por ejemplo:\n  ` + missing.slice(0, 5).join('\n  ') + '\nRevisa tu conexión y vuelve a ejecutar publicar.bat.')
        log(`    Faltan ${missing.length} archivo(s) en GitHub. Reintentando (${intento}/3)...`)
        const stage = path.join(cacheDir, 'subida')
        fs.rmSync(stage, { recursive: true, force: true })
        fs.mkdirSync(stage, { recursive: true })
        for (let i = 0; i < missing.length; i += 10) {
            const chunk = missing.slice(i, i + 10)
            const files = chunk.map(n => {
                const dst = path.join(stage, n)
                try { fs.linkSync(wanted.get(n).local, dst) } catch { fs.copyFileSync(wanted.get(n).local, dst) }
                return dst
            })
            try {
                gh(['release', 'upload', TAG, ...files, '--repo', repo, '--clobber'], { stdio: ['ignore', 'pipe', 'inherit'] })
                for (const n of chunk) manifest[n] = wanted.get(n).md5
            } catch (e) { log('    Error al subir: ' + e.message.split('\n')[0]) }
            files.forEach(f => fs.rmSync(f, { force: true }))
            log(`    ${Math.min(i + 10, missing.length)}/${missing.length}`)
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    }

    // Limpiar los que ya no se usan (con seguro: nunca borra más de la mitad de golpe)
    let stale = existing.map(a => a.name).filter(n => !wanted.has(n))
    if (stale.length > 20 && stale.length > existing.length / 2) {
        log(`    AVISO: ${stale.length} archivos del Release ya no se usan. Por seguridad NO se borran automáticamente.`)
        log('    Si de verdad quitaste tantos mods, bórralos a mano desde la página del Release.')
        stale = []
    }
    for (const n of stale) {
        try { gh(['release', 'delete-asset', TAG, n, '--repo', repo, '-y']); delete manifest[n] } catch { /* no importa */ }
    }
    if (stale.length) log(`    ${stale.length} archivo(s) viejos borrados del Release.`)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    // Quitar valores de ejemplo que Nebula deja en distrometa ("<LINK TO RSS FEED>", etc.)
    if (typeof dist.rss === 'string' && !/^https?:\/\//.test(dist.rss)) delete dist.rss
    if (dist.discord && /FILL IN/.test(JSON.stringify(dist.discord))) delete dist.discord
    for (const sv of dist.servers || []) if (sv.discord && /FILL IN/.test(JSON.stringify(sv.discord))) delete sv.discord

    // 4. distribution.json con las URLs nuevas
    fs.writeFileSync(distPath, JSON.stringify(dist, null, 2))
    log('\n[3/4] distribution.json actualizado.')

    // Modpack para Prism Launcher / MultiMC (packwiz), con las mismas URLs
    const pwScript = path.join(__dirname, 'generar-packwiz.js')
    if (fs.existsSync(pwScript)) {
        log('    Generando modpack para otros launchers (packwiz)...')
        try { require(pwScript).generate({ root: ROOT, dist, baseUrl: BASE, log }) }
        catch (e) { log('    (packwiz falló, AXOL no se ve afectado: ' + e.message + ')') }
    }

    // .gitignore: los mods no van al repositorio (pesan demasiado para Pages)
    const giPath = path.join(ROOT, '.gitignore')
    let gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : ''
    const a = gi.indexOf(MARK_A), b = gi.indexOf(MARK_B)
    if (a >= 0 && b > a) gi = gi.slice(0, a) + gi.slice(b + MARK_B.length)
    const block = [MARK_A, 'servers/*/fabricmods/**/*.jar', 'servers/*/forgemods/**/*.jar',
        ...[...bigNonJar].sort(), MARK_B].join('\n')
    fs.writeFileSync(giPath, gi.trim() + (gi.trim() ? '\n\n' : '') + block + '\n')

    // 5. Git
    log('\n[4/4] Subiendo distribution.json, configs e imágenes a GitHub Pages...')
    const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { stdio: 'inherit' })
    git('rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.')
    git('add', '-A')
    try {
        git('commit', '-m', `Actualizar modpacks ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
    } catch { log('    (No había cambios en el repositorio)') }
    try { git('push') } catch { fail('No se pudo subir a GitHub. Revisa tu conexión.') }

    log('\n===========================================================')
    log(' LISTO. En 1-2 minutos los jugadores verán ACTUALIZAR.')
    log('===========================================================')
}

main()
