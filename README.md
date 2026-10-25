# 🪟 Liquid Glass Linux (macOS Sonoma / Tahoe Aesthetic)

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-45%20|%2046%20|%2047%20|%2050-blue.svg)](https://www.gnome.org/)
[![Display Server](https://img.shields.io/badge/Display-Wayland%20%2F%20X11-purple.svg)]()
[![OS](https://img.shields.io/badge/Tested%20on-Fedora%2044-navy.svg)]()
[![Style](https://img.shields.io/badge/Style-Liquid%20Glass%20%7C%20Apple%20macOS-cyan.svg)]()

Entorno de escritorio completo con estética **Liquid Glass** (*vidrio translúcido esmerilado*), **Dynamic Island** integrada en la barra superior, dock flotante con desenfoque de GPU, tipografía oficial Apple **San Francisco (SF Pro)** y tema **WhiteSur Dark** para GTK4/Libadwaita.

---

## 📸 Vistas Previas

| Barra y Dynamic Island | Reproductor de Música Expandido |
| :---: | :---: |
| ![Modo Reposo](assets/previews/idle-dark.png) | ![Reproductor Liquid Glass](assets/previews/player-dark.png) |

| Bandeja de Avisos y Notificaciones | Controles de Volumen y Brillo OSD |
| :---: | :---: |
| ![Notificaciones](assets/previews/notification-dark.png) | ![Volumen Glass](assets/previews/volume-dark.png) |

| Vista General (Overview) | Calendario Integrado |
| :---: | :---: |
| ![Vista General](assets/previews/overview-dark.png) | ![Calendario](assets/previews/calendar-dark.png) |

---

## ✨ Características Principales

1. **Dynamic Island 100% Unificada (`liquid-island`)**:
   - Píldora central única en la barra superior (elimina el botón duplicado de reloj/calendario).
   - Reloj y fecha en vivo integrados de forma nativa sin procesos en segundo plano innecesarios.
   - **Chip multimedia condicional**: El reproductor solo aparece en la barra superior cuando hay música sonando; en reposo, la isla se contrae elegantemente a solo la hora y fecha.
   - Menú desplegable con **pestañas intercambiables estilo macOS**: `[ 🔔 Notificaciones ]` y `[ 📅 Calendario ]`, con reproductor multimedia en la cabecera cuando está activo.
   - **Animaciones nativas de resortes (*Spring Physics*)**: Curvas `EASE_OUT_BACK` con resplandor de vidrio líquido para la llegada y despedida de notificaciones.
   - Atajo global configurable: **`Super + I`**.

2. **Motor Universal de Fondos Animados (`liquid-live-wallpaper`)**:
   - Soporte para bucles de video de alta definición (4K/1080p) con decodificación por hardware GPU (`hwdec=auto`) y bajo consumo de batería.
   - Presets curados: *macOS Sonoma Horizon*, *Liquid Glass Chromatic Flow* y *Dark Acrylic Aurora*.
   - Pausa automática al maximizar o abrir apps a pantalla completa.

3. **Efecto Liquid Glass Auténtico (`blur-my-shell`)**:
   - Desenfoque translúcido por hardware (*Dual-Kawase shaders*) acelerado por GPU.
   - Optimización de rendimiento con desenfoque estático (*Static Blur*) en panel y vista general para **0.0% de sobrecarga de CPU**.
   - Lista blanca de ventanas con desenfoque translúcido (`spotify`, `ptyxis`, `nautilus`, etc.).

4. **Tema WhiteSur Dark & Libadwaita**:
   - Ventanas con bordes suaves, reflejo especular superior y botones estilo semáforo de macOS.
   - Inyección directa en `~/.config/gtk-4.0/` y compatibilidad con Flatpak mediante permisos globales.

5. **Tipografía Apple San Francisco (SF Pro)**:
   - Familia tipográfica completa de Apple (`SF-Pro-Display` y `SF-Pro-Text`) preconfigurada con subpixel rendering `rgba` y antialiasing nítido.

6. **Dock Flotante Inteligente**:
   - Dock translúcido inferior con auto-ocultado inteligente (se esconde cuando hay ventanas en primer plano y se muestra en el escritorio limpio o al invocar la vista general sin duplicar el dash nativo).

7. **Suite de Skills para Antigravity (`gnome-rice-architect`)**:
   - Skill incluido en `.agents/skills/gnome-rice-architect/SKILL.md` para asistir de forma autónoma en la personalización y desarrollo de extensiones GNOME, estilos CSS translúcidos y monitoreo de DBus.

---

## 📦 Contenido del Paquete

```
liquid-glass-linux/
├── install.sh                  # Instalador automatizado de 1 paso
├── uninstall.sh                # Restaurador del entorno predeterminado de GNOME
├── backup-live.sh              # Sincroniza personalizaciones hechas en vivo hacia el repo
├── scripts/                    # Scripts de utilidades y fondos
│   └── live-wallpaper.sh       # Motor universal de fondos animados (Sonoma, Liquid Glass)
├── .agents/skills/             # Skills para Antigravity
│   └── gnome-rice-architect/   # Asistente de diseño y arquitectura de escritorio
├── extensions/                 # Extensiones de GNOME Shell incluidas
│   ├── liquid-island@pedrogatti.local           # Dynamic Island & Liquid Glass core
│   ├── blur-my-shell@aunetx                     # Motor de desenfoque GPU Dual-Kawase
│   ├── clipboard-indicator@tudmotu.com          # Historial de portapapeles translúcido
│   ├── appindicatorsupport@rgcjonas.gmail.com   # Bandeja de iconos del sistema
│   └── touchpad-gesture-customization@...       # Gestos avanzados de trackpad
├── themes/                     # Temas visuales
│   ├── WhiteSur-Dark*                           # Variantes del tema GTK
│   └── gtk-4.0/                                 # Hoja de estilos Libadwaita y assets
├── fonts/                      # Fuentes tipográficas
│   └── SF-Pro/                                  # Apple San Francisco (Display y Text)
├── widgets/                    # Widgets de escritorio
│   ├── bin/spotify-glass-widget                 # Binario ejecutable del widget flotante
│   └── desktop/spotify-glass-widget.desktop     # Acceso directo para el menú de apps
├── config/                     # Perfiles de configuración
│   ├── liquid-glass-profile.dconf               # Perfil Dconf curado (sin tocar apps favoritas)
│   └── gnome-all-custom.dconf                   # Respaldo completo de GNOME
└── assets/previews/            # Capturas de pantalla
```

---

## 🚀 Requisitos del Sistema

- **Distribución:** Fedora Linux, Arch Linux, Ubuntu 24.04+, Debian o derivados.
- **Entorno:** GNOME Shell 45, 46, 47 o 50 (Wayland o X11).
- **Paquetes recomendados:**
  - Fedora: `sudo dnf install -y glib2-devel fontconfig dconf python3-gobject gtk4 libadwaita`
  - Arch: `sudo pacman -S glib2 fontconfig dconf python-gobject gtk4 libadwaita`
  - Ubuntu/Debian: `sudo apt install -y libglib2.0-bin fontconfig dconf-cli python3-gi gir1.2-gtk-4.0 gir1.2-adw-1`

---

## 🛠️ Instalación Rápida (1 Paso)

1. Cloná o descargá el repositorio:
   ```bash
   cd ~/PROYECTOS
   git clone https://github.com/pedrogattii/liquid-glass-linux.git
   cd liquid-glass-linux
   ```

2. Ejecutá el instalador automatizado:
   ```bash
   ./install.sh
   ```

3. **Aplicar cambios en Wayland:**
   - Para que todos los estilos GTK4 y fuentes se refresquen limpiamente en las aplicaciones abiertas, simplemente **cerrá tu sesión de usuario y volvé a ingresar** (*Log out / Log in*).

---

## ⌨️ Atajos de Teclado Preconfigurados

| Atajo | Acción |
| :--- | :--- |
| **`Super + I`** | Desplegar / Ocultar la **Dynamic Island** (reproductor, alertas, volumen) |
| **`Super + V`** | Abrir menú del **Portapapeles** translúcido |
| **`Super + M`** | Abrir bandeja de **Notificaciones y Calendario** |
| **`Super`** *(Windows)* | Abrir la vista general / Overview con desenfoque de fondo |
| **`Ctrl + Alt + Tab`** | Ciclar foco por teclado entre Panel, Dock y Ventanas |

---

## 🎨 Ajustes y Personalización

### Modificar la intensidad del desenfoque (*Glass Blur*)
Podés ajustar la intensidad del vidrio directamente por terminal o desde la app **Extensiones**:
```bash
# Ajustar intensidad (valor entre 0.0 y 1.0, por defecto 0.85)
gsettings set org.gnome.shell.extensions.liquid-island blur-strength 0.90
```

### Cambiar entre temas Claro, Oscuro o Automático
```bash
# Opciones disponibles: 'auto', 'dark', 'light'
gsettings set org.gnome.shell.extensions.liquid-island appearance 'dark'
```

### Agregar o quitar aplicaciones con desenfoque translúcido
Para que una ventana específica (ej. terminal o navegador) tenga efecto de vidrio, agregala a la lista blanca de Blur My Shell:
```bash
# Consultar aplicaciones actuales
dconf read /org/gnome/shell/extensions/blur-my-shell/applications/whitelist
```

---

## 🔄 Cómo Sincronizar Nuevas Personalizaciones al Repositorio

Si realizás ajustes en tu escritorio (modificás `stylesheet.css`, cambiás fuentes, retocás el código de la isla o agregás nuevos widgets) y querés guardarlos en este repositorio, simplemente ejecutá:

```bash
cd ~/PROYECTOS/liquid-glass-linux
./backup-live.sh
git commit -am "feat: agregada nueva personalización a la isla"
git push
```

---

## 🔙 Desinstalación / Restaurar GNOME

Si querés regresar a la apariencia estándar de fábrica de GNOME:
```bash
./uninstall.sh
```

---

## 🗺️ Próximas Personalizaciones (Roadmap)

- [ ] Tema de vidrio esmerilado para la terminal **Ptyxis** y **Ghostty**.
- [ ] Hoja de estilo `userChrome.css` con estética Liquid Glass para **Brave / Firefox**.
- [ ] Widget de monitoreo de hardware (Uso de CPU, RAM y GPU NVIDIA/AMD en cristal).
- [ ] Soporte para colores de acento dinámicos basados en la carátula de la canción en reproducción.
- [ ] Integración con Discord y clientes de mensajería (burbujas translúcidas).

---

**Creado y optimizado por [pedrogattii](https://github.com/pedrogattii)**.
