# Repositorio de modpacks de AXOL Launcher

Esta carpeta es, a la vez:

- la **raíz de Nebula** (`ROOT` en el `.env` de Nebula), y
- el **repositorio de GitHub** que se publica con **GitHub Pages**.

Todo lo que hay aquí se descarga públicamente desde
`https://TU-USUARIO.github.io/voragos-repo/`.

| Archivo / carpeta | Qué es |
|---|---|
| `distribution.json` | Lo genera Nebula. **No lo edites a mano.** |
| `servers/<id>-<versión>/` | Un modpack por carpeta. |
| `servers/<id>-<versión>/icono.png` | Icono cuadrado (lista de modpacks). |
| `servers/<id>-<versión>/branding/logo.png` | Logo grande de la portada. |
| `servers/<id>-<versión>/branding/fondo.jpg` | Fondo de pantalla del launcher. |
| `crear-modpack.bat` | Crea un modpack nuevo con Nebula. |
| `publicar.bat` | Regenera `distribution.json` y lo sube a GitHub. |

Guía completa: `GUIA-AXOL.md` en el kit.
