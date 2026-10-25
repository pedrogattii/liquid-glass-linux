#!/usr/bin/env bash
# ==============================================================================
# Liquid Glass Linux - Instalador Automatizado
# Entorno visual translúcido estilo Apple macOS Tahoe/Sonoma con Dynamic Island
# ==============================================================================

set -e

# A boot-time update must not contact or reload the running Shell.
OFFLINE=false
if [ "${1:-}" = "--offline" ] && [ "$#" -eq 1 ]; then
    OFFLINE=true
elif [ "$#" -ne 0 ]; then
    echo "Uso: ./install.sh [--offline]" >&2
    exit 2
fi

if [ "${EUID}" -eq 0 ]; then
    echo "Ejecutá ./install.sh como tu usuario, sin sudo. Las personalizaciones se instalan en tu sesión."
    exit 1
fi

# Colores de salida
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-$HOME}"

echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║             Instalador Liquid Glass Linux (macOS Style)            ║"
echo "║          Dynamic Island • Shaders Dual-Kawase • WhiteSur           ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Validaciones de entorno
if ! command -v gnome-shell &>/dev/null; then
    echo -e "${YELLOW}Advertencia: No se detectó 'gnome-shell'. Este paquete está diseñado para GNOME (Fedora, Arch, Ubuntu, etc.).${NC}"
else
    GS_VERSION="$(gnome-shell --version 2>/dev/null || echo 'GNOME detectado')"
    echo -e "${GREEN}✓ Sistema detectado:${NC} ${GS_VERSION}"
fi

echo -e "\n${BOLD}[1/6] Instalando fuentes Apple San Francisco (SF Pro)...${NC}"
FONTS_DIR="${TARGET_HOME}/.local/share/fonts/SF-Pro"
mkdir -p "${FONTS_DIR}"
cp -f "${SCRIPT_DIR}/fonts/SF-Pro/"*.otf "${FONTS_DIR}/"
if command -v fc-cache &>/dev/null; then
    fc-cache -f "${FONTS_DIR}" 2>/dev/null || true
    echo -e "${GREEN}✓ Fuentes SF Pro instaladas e indexadas en el sistema.${NC}"
else
    echo -e "${GREEN}✓ Fuentes copiadas a ${FONTS_DIR}.${NC}"
fi

echo -e "\n${BOLD}[2/6] Instalando temas WhiteSur Dark y configuración GTK4/Libadwaita...${NC}"
THEMES_DIR="${TARGET_HOME}/.themes"
GTK4_DIR="${TARGET_HOME}/.config/gtk-4.0"
mkdir -p "${THEMES_DIR}" "${GTK4_DIR}"

cp -r "${SCRIPT_DIR}/themes/WhiteSur-Dark"* "${THEMES_DIR}/"

# Inyección Libadwaita / GTK4
cp -r "${SCRIPT_DIR}/themes/gtk-4.0/"* "${GTK4_DIR}/"
# Asegurar symlinks relativos correctos para GTK4 Dark
cd "${GTK4_DIR}"
ln -sf gtk-Dark.css gtk.css 2>/dev/null || true
ln -sf gtk-Dark.css gtk-dark.css 2>/dev/null || true
cd "${SCRIPT_DIR}"
echo -e "${GREEN}✓ Temas WhiteSur y hojas de estilo Libadwaita aplicadas.${NC}"

# Soporte Flatpak para que Spotify y otras apps hereden el tema
if command -v flatpak &>/dev/null; then
    echo -e "${CYAN}→ Configurando permisos globales de Flatpak para temas...${NC}"
    flatpak override --user --filesystem=xdg-config/gtk-4.0:ro 2>/dev/null || true
    flatpak override --user --filesystem=~/.themes:ro 2>/dev/null || true
fi

echo -e "\n${BOLD}[3/6] Desplegando paquete de extensiones GNOME Shell...${NC}"
EXT_DIR="${TARGET_HOME}/.local/share/gnome-shell/extensions"
USER_SCHEMAS_DIR="${TARGET_HOME}/.local/share/glib-2.0/schemas"
mkdir -p "${EXT_DIR}" "${USER_SCHEMAS_DIR}"

for ext_path in "${SCRIPT_DIR}/extensions/"*; do
    if [ -d "${ext_path}" ]; then
        ext_uuid="$(basename "${ext_path}")"
        echo -e "  • Instalando ${CYAN}${ext_uuid}${NC}..."
        rm -rf "${EXT_DIR}/${ext_uuid}"
        cp -r "${ext_path}" "${EXT_DIR}/${ext_uuid}"
        
        # Compilación de schemas si existen
        if [ -d "${EXT_DIR}/${ext_uuid}/schemas" ]; then
            cp -f "${EXT_DIR}/${ext_uuid}/schemas/"*.gschema.xml "${USER_SCHEMAS_DIR}/" 2>/dev/null || true
            if command -v glib-compile-schemas &>/dev/null; then
                glib-compile-schemas "${EXT_DIR}/${ext_uuid}/schemas" 2>/dev/null || true
            fi
        fi
    fi
done
if command -v glib-compile-schemas &>/dev/null; then
    glib-compile-schemas "${USER_SCHEMAS_DIR}" 2>/dev/null || true
fi
echo -e "${GREEN}✓ Extensiones instaladas y schemas GSettings compilados.${NC}"

echo -e "\n${BOLD}[4/6] Instalando Widget flotante de Spotify Liquid Glass...${NC}"
BIN_DIR="${TARGET_HOME}/.local/bin"
DESKTOP_DIR="${TARGET_HOME}/.local/share/applications"
mkdir -p "${BIN_DIR}" "${DESKTOP_DIR}"

cp -f "${SCRIPT_DIR}/widgets/bin/spotify-glass-widget" "${BIN_DIR}/spotify-glass-widget"
chmod +x "${BIN_DIR}/spotify-glass-widget"
cp -f "${SCRIPT_DIR}/widgets/desktop/spotify-glass-widget.desktop" "${DESKTOP_DIR}/spotify-glass-widget.desktop"
cp -f "${SCRIPT_DIR}/scripts/live-wallpaper.sh" "${BIN_DIR}/liquid-live-wallpaper"
chmod +x "${BIN_DIR}/liquid-live-wallpaper"

if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "${DESKTOP_DIR}" 2>/dev/null || true
fi
echo -e "${GREEN}✓ Widget 'spotify-glass-widget' instalado en ${BIN_DIR}.${NC}"

echo -e "\n${BOLD}[5/6] Aplicando configuraciones de apariencia y Dconf...${NC}"
if command -v dconf &>/dev/null; then
    dconf load / < "${SCRIPT_DIR}/config/liquid-glass-profile.dconf"
    echo -e "${GREEN}✓ Perfil de Dconf aplicado exitosamente.${NC}"
else
    # Fallback con gsettings
    echo -e "${YELLOW}Dconf no disponible directamente, aplicando vía gsettings...${NC}"
    gsettings set org.gnome.desktop.interface gtk-theme 'WhiteSur-Dark' 2>/dev/null || true
    gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark' 2>/dev/null || true
    gsettings set org.gnome.desktop.interface font-name 'SF Pro Text 11' 2>/dev/null || true
    gsettings set org.gnome.desktop.interface document-font-name 'SF Pro Text 10.5' 2>/dev/null || true
    gsettings set org.gnome.desktop.wm.preferences button-layout 'appmenu:minimize,maximize,close' 2>/dev/null || true
    gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null || true
    gsettings set org.gnome.shell disable-extension-version-validation true 2>/dev/null || true
fi

echo -e "\n${BOLD}[6/6] Habilitando extensiones activas...${NC}"
EXTENSIONS=(
    "liquid-island@pedrogatti.local"
    "blur-my-shell@aunetx"
    "clipboard-indicator@tudmotu.com"
    "appindicatorsupport@rgcjonas.gmail.com"
    "touchpad-gesture-customization@coooolapps.com"
)

if [ "$OFFLINE" = false ] && command -v gnome-extensions &>/dev/null; then
    for ext in "${EXTENSIONS[@]}"; do
        gnome-extensions enable "${ext}" 2>/dev/null || true
        echo -e "  • Habilitada: ${GREEN}${ext}${NC}"
    done
fi

echo -e "\n${GREEN}${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}¡Instalación completada con éxito!${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "\n${BOLD}Atajos rápidos disponibles:${NC}"
echo -e "  • ${CYAN}Super + I${NC}       Desplegar / Ocultar la Dynamic Island (música, alertas, controles)"
echo -e "  • ${CYAN}Super + V${NC}       Historial del portapapeles translúcido"
echo -e "  • ${CYAN}Super + M${NC}       Bandeja de avisos del sistema"
echo -e "  • ${CYAN}liquid-live-wallpaper list${NC}   Fondos animados Liquid Glass / Sonoma"
echo -e "\n${YELLOW}Nota para Wayland:${NC} Si no ves reflejados los cambios de inmediato en algunas apps GTK,"
echo -e "cerrá sesión y volvé a ingresar (Log out / Log in) para refrescar todos los motores visuales.\n"
