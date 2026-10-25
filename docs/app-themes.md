# Temas de aplicaciones

Los assets se encuentran en `assets/app-themes/`. La herramienta `scripts/configure-app-themes.sh` muestra el plan por defecto; sólo escribe con `--apply`. No inicia, cierra ni reinicia aplicaciones, no instala paquetes y no escribe en directorios del sistema. Requiere Bash y Python 3; el destino Ptyxis también necesita `gsettings` y los schemas de la instalación nativa.

| Aplicación | Qué incluye | Transparencia real |
| --- | --- | --- |
| Ptyxis nativo | Paleta clara/oscura y opacidad de fondo por perfil | Sí, mediante `opacity`; el desenfoque depende del compositor |
| Ghostty | Tema de colores, snippet e inclusión en la configuración | Sí, mediante `background-opacity`; GNOME necesita su propia integración de blur |
| Firefox | Estilo de barras/pestañas y activación de CSS del perfil | El estilo no habilita alfa de la ventana nativa ni desenfoque del escritorio |
| Brave/Chromium | Tema local Manifest V3 con colores, sin scripts ni permisos | El tema cambia colores sólidos; no habilita alfa ni desenfoque |

Un fondo RGBA dentro de una aplicación opaca mezcla colores con la propia ventana. Para ver el escritorio hacen falta soporte alfa de la aplicación y una integración compatible del compositor. CSS y un tema Chromium no pueden proporcionar ese soporte por sí solos.

## Revisar y aplicar

Desde la raíz del repositorio:

```bash
# Sólo revisar; no se crean archivos, backups ni perfiles.
./scripts/configure-app-themes.sh ptyxis
./scripts/configure-app-themes.sh ghostty
./scripts/configure-app-themes.sh brave
./scripts/configure-app-themes.sh firefox --profile /ruta/explicita/al/perfil

# Opt-in: elegir únicamente los destinos deseados.
./scripts/configure-app-themes.sh ptyxis --apply
./scripts/configure-app-themes.sh ghostty --apply
./scripts/configure-app-themes.sh brave --apply
./scripts/configure-app-themes.sh firefox --profile /ruta/explicita/al/perfil --apply
```

Los archivos existentes conservan sus permisos. Antes de escribir se guarda una copia privada en `$XDG_STATE_HOME/liquid-glass-linux/app-themes/<fecha-id>/` (por defecto `~/.local/state/...`). Cada ejecución imprime la ruta exacta y el comando para deshacer. Los archivos propios del proyecto tienen backup incluso si ya existían; en configuraciones compartidas sólo se añade o actualiza un bloque delimitado `LIQUID GLASS LINUX APP THEME`. Las ejecuciones repetidas no duplican el bloque.

La herramienta rechaza enlaces simbólicos para evitar reemplazar archivos de dotfiles indirectamente. Si una configuración utiliza symlinks, integrá los assets manualmente en su repositorio de origen. Se respetan `XDG_CONFIG_HOME`, `XDG_DATA_HOME` y `XDG_STATE_HOME`; los tests usan directorios temporales y un `gsettings` falso.

## Ptyxis

Se instala `liquid-glass.palette` en `$XDG_DATA_HOME/org.gnome.Ptyxis/palettes/`. Ofrece variantes `[Light]` y `[Dark]`, 16 colores ANSI y colores de cursor/ventana. La ubicación y el formato se contrastaron con el [proyecto Ptyxis](https://gitlab.gnome.org/chergert/ptyxis/-/blob/main/README.md) y la paleta GNOME incluida en el paquete instalado.

Se usa el perfil existente que indica `org.gnome.Ptyxis default-profile-uuid`; también se puede elegir explícitamente:

```bash
./scripts/configure-app-themes.sh ptyxis --profile UUID_EXISTENTE --apply
```

El UUID debe estar registrado en `org.gnome.Ptyxis profile-uuids`. No se crean perfiles. El schema instalado `/usr/share/glib-2.0/schemas/org.gnome.Ptyxis.gschema.xml` define `palette` como string y `opacity` como double entre 0 y 1 en el schema relocatable `org.gnome.Ptyxis.Profile`. El destino concreto es:

```text
org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/<UUID>/
    palette = 'liquid-glass'
    opacity = 0.84
```

El backup registra los valores anteriores de ambas claves y los recupera con `--restore`. Si falla una escritura de preferencias, la herramienta revierte las operaciones que ya completó. Este destino configura Ptyxis nativo; las variantes Flatpak tienen rutas/schemas propios y requieren integración manual. La herramienta no escribe en sus sandboxes.

## Ghostty

Se instalan `$XDG_CONFIG_HOME/ghostty/themes/Liquid Glass` y `liquid-glass.conf`. El snippet selecciona el tema y una opacidad de `0.84`. No cambia fuentes, atajos ni comandos de inicio. Los temas se resuelven en el subdirectorio `themes` de la configuración, según la [documentación de temas de Ghostty](https://ghostty.org/docs/features/theme).

Si existe `ghostty/config`, la inclusión se añade allí: la documentación actual indica que el archivo heredado se carga después de `config.ghostty`. Si no existe, se utiliza `config.ghostty`. La inclusión `config-file = "liquid-glass.conf"` es relativa al archivo principal y se procesa después de él; por eso el snippet puede reemplazar una opacidad configurada previamente sin borrar esa línea. Una inclusión posterior del usuario puede volver a reemplazarla. Ver [ubicación y orden de configuración](https://ghostty.org/docs/config).

La opacidad afecta al fondo del terminal; programas que dibujan sus propios fondos de celda pueden seguir siendo opacos. La opción nativa de blur de Ghostty no soporta GNOME directamente, por lo que se utiliza la integración del compositor ya elegida por el usuario. No se añaden flags experimentales ni se modifica esa integración. Ver [referencia de opacidad y blur](https://ghostty.org/docs/config/reference#background-opacity).

## Firefox

Se exige `--profile` con un directorio existente. Se puede encontrar la ruta del perfil en `about:support` o `about:profiles`; la herramienta no busca ni elige automáticamente el perfil activo. Cuando decidas activar el tema, elegí un momento apropiado para cerrar Firefox por tu cuenta y ejecutar el comando; la herramienta nunca lo cierra.

Se incorpora el CSS al archivo `chrome/userChrome.css` sin eliminar reglas previas y se añade únicamente esta preferencia al `user.js` existente:

```javascript
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
```

El CSS cambia el fondo y los bordes de barras/pestañas; conserva el contenido web, la disposición de controles y el comportamiento del navegador. No altera preferencias de seguridad, red o contenido. Mozilla documenta la carga desde el directorio `chrome` del perfil y su preferencia de activación; los selectores internos pueden cambiar con nuevas versiones y no son una API estable. Ver la [guía de personalización avanzada con CSS](https://support.mozilla.org/en-US/kb/contributors-guide-firefox-advanced-customization).

Los cambios se cargan al iniciar el perfil. Si Firefox ya llegó a cargar el `user.js`, puede haber persistido el valor `true` en `prefs.js`: restaurar nuestros archivos no modifica ese archivo del navegador. Para volver al valor anterior de activación, revisá o restablecé esa preferencia en `about:config` cuando corresponda. No la desactives si tus otras personalizaciones también la necesitan.

## Brave / Chromium

Brave no utiliza `userChrome.css`. Se instala una carpeta de tema independiente en `$XDG_DATA_HOME/liquid-glass-linux/brave-theme/`; no se modifican perfiles ni archivos `Preferences` del navegador.

Para cargarla manualmente en Linux, abrí `brave://extensions`, activá **Modo desarrollador**, elegí **Cargar descomprimida** y seleccioná esa carpeta. El asset es un tema de colores RGB con `manifest_version: 3`, sin JavaScript, HTML, permisos ni scripts de contenido, conforme al [formato oficial de temas Chromium](https://developer.chrome.com/docs/extensions/develop/ui/themes). Brave admite extensiones Chromium; las políticas del navegador pueden limitar su carga local. Ver [ayuda oficial de extensiones de Brave](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave).

Los colores cubren las superficies que el navegador expone al sistema de temas. El contenido web, algunas superficies propias de Brave y su nueva pestaña pueden mantener su apariencia. El tema no proporciona transparencia del escritorio. Para retirarlo, usá la opción de restablecer tema en Apariencia; restaurar el backup sólo recupera los archivos instalados, no cambia el tema seleccionado en el navegador.

## Deshacer y verificar

```bash
# Revisar la restauración, sin cambios.
./scripts/configure-app-themes.sh --restore /ruta/impresa/del/backup

# Restaurar archivos y, para Ptyxis, sus dos preferencias anteriores.
./scripts/configure-app-themes.sh --restore /ruta/impresa/del/backup --apply

# Verificaciones que no tocan configuraciones reales.
bash -n scripts/configure-app-themes.sh tests/app-themes-safe.sh
bash tests/app-themes-safe.sh
```

La restauración carga primero todos los originales del backup, verifica que sean archivos regulares con el SHA-256 registrado, valida los valores de preferencias y comprueba que los destinos sigan como los dejó esa ejecución. Un payload faltante o corrupto detiene la operación antes de escribir. Si falla una escritura durante la restauración, se recupera el estado que había justo antes del intento; cualquier fallo adicional del rollback se informa explícitamente. Si detecta una edición posterior, se detiene antes de escribir para conservarla; los originales siguen disponibles en el backup para recuperación manual. Los archivos que antes no existían se eliminan; pueden quedar directorios vacíos. Si aplicaste varias veces, restaurá los backups en orden inverso cuando sus contenidos difieran.

Los tests cubren dry-run de los cuatro destinos, perfil Firefox explícito, preservación de configuraciones, idempotencia de bloques, ambos nombres de configuración Ghostty, tema Chromium sin permisos, rutas/UUIDs Ptyxis, restauración, rechazo de cambios posteriores, payloads faltantes/corruptos/no regulares, valores de preferencias inválidos, symlinks y rollback ante fallos de escritura tanto de archivos como de preferencias. No equivalen a una prueba visual dentro de las aplicaciones ni a una validación de blur en una sesión GNOME real.
