# Validación — 25 de octubre de 2026

Entorno verificado: GNOME Shell/Mutter 50.6, GTK 4.22, Node.js 24.18 y GJS. Las pruebas gráficas usaron una pantalla Wayland headless, bus D-Bus y directorios XDG temporales; no se recargó la sesión de trabajo ni se aplicaron temas a las aplicaciones reales.

## Comandos reproducibles

```bash
./tests/run-checks.sh
./tests/run-shell-smoke.sh
```

La primera suite necesita Node.js 24+, Python 3, Bash y GLib. La segunda necesita GNOME Shell 50, GJS, GTK4/libadwaita y dbus-run-session. La configuración y el entorno de activación D-Bus de esta prueba se preparan antes de arrancar el bus; los servicios del sistema de prueba no heredan la configuración del escritorio activo.

## Resultados

- Regresiones de animación y callbacks obsoletos: siete escenarios.
- Servicio musical: apertura, pausa, selección, navegadores, Raise, seek, sustitución de propietarios y limpieza con bus simulado.
- Perfiles: tipos JSON exactos, límites, versiones y rechazo previo a la escritura.
- Geometría: cuatro bordes del dock, escalado, monitores desplazados y recuperación de widgets.
- Proveedores: calendario, cancelación de respuestas tardías y suspensión de clima; once pruebas de widgets/proveedores.
- GPU: métricas nativas, valores desconocidos, deduplicación, consulta opcional, timeout y cancelación.
- Temas: dry-run, preservación, idempotencia, respaldos y rollback de aplicación/restauración, incluidos backups ausentes/corruptos y fallos inyectados.
- Desenfoque: las superficies externas se destruyen antes que los gestores compartidos. Esta regresión se verifica de forma aislada y mediante el cierre real del compositor de prueba.
- EGO: sin errores bloqueantes en Liquid Island. Hay advertencias heurísticas sobre APIs privadas, tamaño de módulos y licencia; no se presenta esta revisión como una aprobación de extensions.gnome.org.
- Bundle nativo: empaquetado verificado con todos sus módulos, CSS y schema, sin los tests.

## Ocho escenarios reales de GNOME

1. Los doce widgets crean actores reales bajo las ventanas.
2. Dock en cuatro bordes y autoocultado desactivado.
3. Movimiento/redimensionamiento mediante teclado virtual real, guardado y restablecimiento.
4. Reordenamiento de contenedores reales de la isla.
5. Overview durante el cierre de un popup: se ocultan superficie y captura.
6. Reproductor MPRIS real de prueba: pausa, reproducción, nueva pausa y salida.
7. Primer ciclo de desactivación/activación: sin actores ni fuentes duplicados.
8. Segundo ciclo de desactivación/activación: misma comprobación.

Todos pasaron con el Blur My Shell incluido y el proceso de prueba terminó normalmente. También se comprobó la variante sin Blur My Shell. Las pruebas no reproducen la secuencia física exacta del gesto de la captura original, pero cubren la carrera de cancelación identificada.

Spotify real respondió a consultas de identidad, estado y capacidades MPRIS. No se alteró su reproducción. Brave no tenía una sesión MPRIS activa y no se abrió contenido para crearla. Los monitores desconectados y escalados se validan mediante pruebas de geometría; no se modificó la distribución física de pantallas.

## Trabajo de agentes

- Codex gpt-6.1-sol/high: implementación, regresiones y auditorías cruzadas.
- Gemini 3.8 Flash High (`agy`): diagnóstico y revisión final de restauración; revisión final sin hallazgos nuevos.
- Gemini 3.8 Flash High (`agy2`): guía de widgets nativos, posteriormente revisada y ajustada por el director.
- Director: integración, correcciones de auditoría, pruebas, empaquetado y publicación.

La supervisión de Gemini utiliza timeout nativo y salida stream-json para distinguir progreso, éxito e interrupciones. Ambas cuentas respondieron a pruebas mínimas y entregaron trabajo real; no fue necesario modificar su autenticación.
