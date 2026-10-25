# Guía de Widgets Nativos y Centro de Personalización

Esta guía detalla el funcionamiento del centro de personalización y los 12 widgets nativos de escritorio integrados en Liquid Glass (`liquid-island`).

---

## 1. Centro de Personalización

Se accede desde el menú contextual del fondo de pantalla (**Personalizar Liquid Glass…**), mediante el botón de configuración de la Dynamic Island o ejecutando:
```bash
gnome-extensions prefs liquid-island@pedrogatti.local
```

La ventana de preferencias (basada en Libadwaita) organiza los ajustes en páginas:
- **Distribución:** Control del modo de edición, ajuste a cuadrícula (12 px), borde del dock (Inferior, Superior, Izquierdo, Derecho), orden de módulos de la isla y exportación/importación de perfiles.
- **Barra:** Ordenamiento de los grupos de elementos izquierdos y derechos del panel superior.
- **Widgets:** Catálogo de widgets con interruptores de activación individual, selector de monitor por conector, ajuste fino numérico de coordenadas (`x`, `y`) y dimensiones (`width`, `height`), editor de nota local y duración del temporizador.
- **Integraciones:** Opciones de visibilidad para música en la isla y en tarjeta de escritorio, notificaciones de mensajería y estado de los servicios nativos del sistema.

Las secciones con restablecimiento incluyen un botón **Restablecer esta sección** con una notificación emergente (*Toast*) que ofrece la acción **Deshacer**.

---

## 2. Catálogo de los 12 Widgets Nativos

Los widgets se dibujan en la capa de fondo (`Meta.BackgroundGroup`), permaneciendo siempre debajo de las ventanas activas. Se ocultan de forma automática durante el bloqueo de sesión, pantalla de bienvenida (*greeter*) y en la vista general (*Overview*).

| Widget | Identificador | Dimensiones iniciales | Tamaño mínimo | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| **Reloj** | `clock` | 260 × 160 px | 200 × 140 px | Muestra hora y fecha actual. Respeta el formato de 24 horas y la visualización opcional de segundos según los ajustes. |
| **Calendario** | `calendar` | 340 × 370 px | 200 × 140 px | Mes en curso, grilla con marcas de eventos y lista de hasta 3 próximos eventos sincronizados con el servicio de calendario de GNOME. |
| **Clima** | `weather` | 280 × 210 px | 200 × 140 px | Ícono del estado meteorológico, temperatura actual, ubicación y estado. Incluye botón directo para abrir GNOME Weather. |
| **CPU** | `cpu` | 240 × 150 px | 200 × 140 px | Porcentaje de uso de la CPU y temperatura del procesador en °C cuando el sistema expone el sensor. |
| **Memoria** | `ram` | 240 × 150 px | 200 × 140 px | Porcentaje de uso de la memoria RAM del sistema. |
| **GPU** | `gpu` | 300 × 210 px | 200 × 140 px | Nombre del dispositivo gráfico activo, porcentaje de utilización y desglose de VRAM usada frente al total disponible. |
| **Música** | `music` | 340 × 230 px | 200 × 140 px | Carátula del álbum, título, artista, controles de reproducción (anterior, pausar/reanudar, siguiente), barra de progreso arrastrable y selector entre múltiples reproductores. |
| **Aplicaciones** | `launchers` | 300 × 190 px | 200 × 140 px | Hasta 10 accesos directos configurados en la lista de aplicaciones fijadas (`pinned-island-apps`), con ícono nativo y nombre. |
| **Notas** | `notes` | 300 × 250 px | 200 × 140 px | Editor de texto multilínea local. Guarda automáticamente con un retardo de 500 ms y al perder el foco del teclado. |
| **Tareas** | `tasks` | 300 × 290 px | 200 × 140 px | Lista de verificación de hasta 100 tareas locales pendientes o completadas, con casilla de marcado y campo para añadir nuevas tareas. |
| **Temporizador** | `timer` | 260 × 210 px | 200 × 140 px | Cronómetro regresivo con botones de Iniciar/Pausar y Reiniciar, y aviso de tiempo cumplido. Duración configurable en segundos. |
| **Discord** | `discord` | 280 × 190 px | 200 × 140 px | Acceso directo para iniciar o enfocar la aplicación oficial de Discord cuando se encuentra instalada en el equipo. |

---

## 3. Activación Individual

- Cada widget se habilita o inhabilita de manera independiente desde la pestaña **Widgets** mediante su respectivo conmutador.
- Por defecto, solo el widget de **Música** se encuentra preactivado, mostrándose únicamente cuando se detecta un reproductor presente en el sistema.
- Cada tipo de widget admite exactamente una instancia en pantalla.

---

## 4. Mover y Redimensionar con Mouse y Teclado

El modo de edición se activa con el atajo global:
$$\text{\textbf{Super + Shift + W}}$$
o activando el interruptor **Modo de edición** en Preferencias. Al estar activo, cada widget expone su cabecera superior y un tirador de redimensionado en la esquina inferior derecha.

### Control con Mouse
- **Mover:** Arrastrar desde la cabecera del widget. Al mover el cursor hacia otra pantalla conectada, el widget cambia de monitor automáticamente.
- **Redimensionar:** Arrastrar el tirador inferior derecho (`view-fullscreen-symbolic`).
- **Cancelar:** Presionar la tecla `Escape` durante el arrastre cancela la operación y restituye la posición o tamaño original.
- **Cuadrícula:** Si está habilitada la opción *Ajustar a cuadrícula*, el movimiento y el tamaño se alinean a pasos de 12 px.

### Control con Teclado
- Enfocar la cabecera o el tirador del widget (mediante navegación de foco o clic).
- **Flechas (`←`, `→`, `↑`, `↓`):** Mueven el widget (1 px o 12 px según la cuadrícula).
- **Shift + Flechas:** Redimensionan el ancho y alto del widget (o flechas directas cuando el foco está sobre el tirador de redimensionado).
- **Escape:** Cancela el ajuste en curso y devuelve el widget a sus coordenadas previas.
- El guardado en la configuración se realiza al soltar la tecla o al perder el foco.

---

## 5. Gestión de Monitores y Tolerancia a Desconexión

- La ubicación de cada widget se almacena vinculada al conector del monitor (`connector`, por ejemplo `eDP-1`, `DP-1`, `HDMI-A-1`).
- Desde la sección de cada widget en Preferencias se puede asignar explícitamente a un monitor conectado o al *Monitor principal*.
- **Recuperación tras desconexión:** Si un monitor configurado deja de estar disponible (por ejemplo, al desconectar una pantalla externa), el sistema recupera el widget reubicándolo temporalmente en la pantalla principal. Esta recolocación es meramente una vista de rescate y **no sobrescribe la asignación del conector guardado** en la configuración hasta que el usuario decida mover o redimensionar explícitamente el widget en su nueva pantalla.
- La escala y el posicionamiento se adaptan en tiempo real ante eventos de cambio de monitores (`monitors-changed`) o factor de escala (`scale-factor`).

---

## 6. Exportación e Importación (Versión 1)

En la sección **Guardar distribución y preferencias** de la pestaña Distribución:
- **Exportar ajustes…:** Genera un archivo JSON con estructura formal versión 1:
  ```json
  {
    "format": "liquid-glass",
    "version": 1,
    "settings": { ... }
  }
  ```
  Incluye el estado de los widgets habilitados, la distribución de coordenadas (`widget-layout`), las notas locales, las tareas y las preferencias visuales.
- **Importar ajustes…:** Permite cargar un perfil guardado. Aplica validaciones estrictas:
  - Archivo regular de hasta 2 MiB de tamaño.
  - Formato `liquid-glass` y `version: 1` obligatorios.
  - Validación de tipos GLib Variant y comprobación de rangos admisibles según el esquema GSettings.
  - Verificación de integridad estructural del layout de widgets (`parseLayout`).
  - La aplicación de valores se realiza de forma transaccional mediante `delay()` y `apply()` para evitar estados inconsistentes.

---

## 7. Política de Música: Visibilidad Persistente

La integración con reproductores multimedia sigue una política de ciclo de vida persistente:
- **Pausada o detenida:** Al poner en pausa (`Paused`) o detener (`Stopped`) la reproducción, la tarjeta de música **permanece visible en el escritorio**. Muestra la carátula, los metadatos y la posición que el reproductor siga publicando; reanudar depende de sus capacidades.
- **Salida de la aplicación:** La tarjeta solo desaparece del escritorio cuando la aplicación reproductora finaliza su proceso. En navegadores, la presencia depende de que continúe publicada la sesión multimedia MPRIS. Cerrar la ventana gráfica de la aplicación (por ejemplo, minimizándola al área de notificación o bandeja) **no oculta la tarjeta** si el proceso continúa ejecutándose.
- En modo de edición, la tarjeta de música permanece visible forzadamente para permitir su reubicación aunque no haya ningún reproductor abierto.

---

## 8. Límites Reales de las Integraciones

Las capacidades de los widgets se limitan a las APIs y servicios verificados del sistema operativo, sin simulación de funciones inexistentes:
- **MPRIS (Spotify, reproductores locales y navegadores):**
  - Los controles activos (`Previous`, `PlayPause`, `Next`, `Seek`) dependen estrictamente de lo que declare cada reproductor vía D-Bus (`CanPlay`, `CanPause`, `CanSeek`, `CanGoNext`, `CanGoPrevious`).
  - Si el reproductor no soporta posicionamiento o la pista carece de duración (`length = 0`), la barra de progreso se inhabilita.
  - Las imágenes de carátula están limitadas a URIs seguras (`https://` o `file:///`) y a archivos locales regulares de tipo imagen que no superen los 2 MiB (`MAX_COVER_BYTES`).
- **Discord:**
  - El widget actúa exclusivamente como un lanzador de escritorio para la aplicación oficial.
  - **No ofrece controles de voz, estado de canales ni silenciamiento de micrófono**, dado que estas funciones requieren una integración externa vía RPC de Discord que no está implementada ni verificada.
- **Clima (GWeather):**
  - Requiere GWeather 4 y una ubicación guardada previamente por el usuario en la aplicación **GNOME Weather**.
  - Si no hay ubicación configurada o no hay conectividad de red, el widget muestra el estado no disponible .
- **Calendario:**
  - Obtiene los eventos a través del servicio oficial de calendario de GNOME y las cuentas en línea conectadas al entorno de escritorio.
- **Métricas de GPU:**
  - La consulta de telemetría gráfica solo se ejecuta cuando el widget de GPU está efectivamente visible. Admite lectura nativa vía `sysfs` (controladores AMD) y consulta controlada con tiempo de espera a `nvidia-smi` (NVIDIA). En controladores que no exponen métricas, se muestra claramente el estado no compatible.
