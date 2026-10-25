#!/usr/bin/env bash
# ==============================================================================
# Liquid Glass Linux - Desinstalador y Restaurador
# ==============================================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

TARGET_HOME="${HOME}"

echo -e "${YELLOW}${BOLD}Restaurando entorno por defecto de GNOME...${NC}"

# 1. Restaurar fuentes e interfaz GNOME estándar
echo -e "→ Restaurando tema Adwaita y fuentes estándar..."
gsettings set org.gnome.desktop.interface gtk-theme 'Adwaita' 2>/dev/null || true
gsettings set org.gnome.desktop.interface font-name 'Cantarell 11' 2>/dev/null || true
gsettings set org.gnome.desktop.interface document-font-name 'Cantarell 11' 2>/dev/null || true
gsettings set org.gnome.desktop.wm.preferences button-layout ':minimize,maximize,close' 2>/dev/null || true

# 2. Deshabilitar extensiones
echo -e "→ Deshabilitando extensiones Liquid Glass..."
EXTENSIONS=(
    "liquid-island@pedrogatti.local"
    "blur-my-shell@aunetx"
    "clipboard-indicator@tudmotu.com"
    "touchpad-gesture-customization@coooolapps.com"
)

if command -v gnome-extensions &>/dev/null; then
    for ext in "${EXTENSIONS[@]}"; do
        gnome-extensions disable "${ext}" 2>/dev/null || true
    done
fi

# 3. Limpiar overrides de GTK4 si el usuario lo desea
if [ -d "${TARGET_HOME}/.config/gtk-4.0" ]; then
    echo -e "→ Limpiando overrides en ~/.config/gtk-4.0/..."
    rm -rf "${TARGET_HOME}/.config/gtk-4.0/assets" \
           "${TARGET_HOME}/.config/gtk-4.0/windows-assets" \
           "${TARGET_HOME}/.config/gtk-4.0/gtk.css" \
           "${TARGET_HOME}/.config/gtk-4.0/gtk-Dark.css" \
           "${TARGET_HOME}/.config/gtk-4.0/gtk-Light.css" \
           "${TARGET_HOME}/.config/gtk-4.0/gtk-dark.css" 2>/dev/null || true
fi

echo -e "\n${GREEN}✓ Entorno restaurado al estado base de GNOME.${NC}"
echo -e "${CYAN}Tip:${NC} Para aplicar los cambios visuales por completo, cerrá y volvé a iniciar sesión."
