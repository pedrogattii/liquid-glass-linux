# Integraciones nativas — 25 de octubre de 2026

## Música: servicio compartido

La isla y la tarjeta de escritorio consumen una sola instancia de `Music`. El servicio ofrece `state`, `players`, `subscribe(callback)` (devuelve una función para desconectarse), `selectPlayer(name)` (`null` restaura selección automática), `command`, `seek`, `raise` y posición interpolada. `state.present` expresa presencia; `connected` expresa disponibilidad MPRIS; `playing` expresa reproducción. Las superficies no condicionan su existencia a `playing`.

Se descubren nombres `org.mpris.MediaPlayer2.*` y se consultan `Identity`, `DesktopEntry`, estado y capacidades. Las consultas no activan aplicaciones. Spotify y reproductores nativos identificados por sus categorías pueden aparecer antes de registrar MPRIS. Los propietarios únicos de D-Bus permiten conservar presencia al cerrar la ventana o perder temporalmente el nombre MPRIS. Sin una interfaz MPRIS o de presencia verificable no se promete controlar una aplicación arbitraria.

Brave utiliza el mecanismo multimedia de Chromium: sus sesiones MPRIS aparecen cuando el navegador expone contenido multimedia. Abrir el navegador sin una sesión no crea una tarjeta vacía. Las capacidades de pista anterior/siguiente dependen del sitio y se desactivan cuando el reproductor no las anuncia. La selección manual evita que otro reproductor desplace al elegido mientras siga disponible.

Fuentes primarias: [MPRIS Player](https://specifications.freedesktop.org/mpris/latest/Player_Interface.html), [identidad y DesktopEntry](https://specifications.freedesktop.org/mpris/latest/Media_Player.html), [implementación MPRIS de Chromium](https://chromium.googlesource.com/chromium/src/+/main/components/system_media_controls/linux/).

## Discord: evidencia REA y alcance

Se analizó estáticamente con REA 6.5.0 el módulo instalado `discord_rpc` del cliente 1.0.166. Se seleccionaron `index.js`, `RPCIPC.js` y `RPCWebSocket.js`. El código expone transportes IPC y WebSocket; la presencia de esos transportes no prueba autorización ni acceso a comandos de voz. No se ejecutó código del cliente, no se conectó al RPC y no se leyeron cuentas, mensajes ni tokens.

- Evidencia: `ev_26f7a50e2480bdc557df27fef1a97c03c5b91b9184c6fbf2109337944236e4df`.
- SHA-256 del artefacto inventariado: `a71abef6c58f9efeb1bdba68d76049b2a323a81485814ebefd6db2e27c7455b6`.
- Cobertura: tres archivos seleccionados, 58 nodos; 18 archivos inventariados quedaron fuera del análisis. Las relaciones dinámicas y el comportamiento efectivo siguen sin verificarse.
- El resultado íntegro permanece en `/tmp/director-rea-discord.json` en la máquina de investigación; no se redistribuye código de Discord en este repositorio.

Discord documenta que `rpc.voice.read` y `rpc.voice.write` requieren su aprobación. No se implementan controles que aparenten funcionar ni se utilizan credenciales del cliente. El widget propio abre Discord, las notificaciones nativas pueden usar burbujas de cristal y el panel muestra que el estado y los controles de voz no están disponibles. La futura integración necesita una aplicación registrada, permisos aprobados y un flujo explícito de autorización del usuario.

Fuentes: [RPC oficial](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rpc.mdx), [scopes OAuth2](https://discord.com/developers/docs/topics/oauth2).

El diagnóstico REA confirmó CLI 6.5.0 disponible, pero registro MCP de Codex ausente. Se utilizó la CLI fijada a esa versión; no se modificó la configuración de Codex ni se instaló un descompilador. El análisis JavaScript estático no necesita Hopper ni Ghidra.

## Complementos investigados

| Proyecto | Capacidades documentadas | Decisión |
| --- | --- | --- |
| [Gridgets](https://github.com/rebatnaath/gridgets) | Rejilla, widgets movibles/redimensionables, música, notas y monitores; documenta conflictos de interacción con DING | Referencia de experiencia; motor propio en Liquid Glass |
| [Desktop Widgets](https://extensions.gnome.org/extension/9071/desktop-widgets/) | Sistema modular nativo; versión publicada para GNOME 50 | Referencia, sin dependencia |
| [Desktop Clock](https://extensions.gnome.org/extension/5156/desktop-clock/) | Relojes, clima, texto y widgets arrastrables | Referencia, sin dependencia |
| [Just Perfection](https://extensions.gnome.org/extension/3843/just-perfection/) | Visibilidad, posición y comportamiento de elementos de Shell | No instalar junto al controlador de distribución propio por defecto |
| [Open Bar](https://extensions.gnome.org/extension/6580/open-bar/) | Apariencia de barra, menús, dock y aplicaciones | Referencia visual; evitar dos controladores simultáneos sobre las mismas superficies |

No se instalaron motores competidores. Si se activa DING u otra extensión que cubre el fondo, puede interceptar los clics destinados a widgets: se debe revisar la convivencia antes de habilitarlos juntos.
