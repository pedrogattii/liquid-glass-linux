#!/usr/bin/env bash
# ==============================================================================
# Liquid Glass Linux - Sincronizador de Cambios en Vivo
# Actualiza el repositorio con las modificaciones recientes que hagas en tu sistema.
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-$HOME}"

echo "→ Sincronizando extensiones desde ~/.local/share/gnome-shell/extensions/..."
for ext in "liquid-island@pedrogatti.local" "blur-my-shell@aunetx" "clipboard-indicator@tudmotu.com" "appindicatorsupport@rgcjonas.gmail.com" "touchpad-gesture-customization@coooolapps.com"; do
    if [ -d "${TARGET_HOME}/.local/share/gnome-shell/extensions/${ext}" ]; then
        rm -rf "${SCRIPT_DIR}/extensions/${ext}"
        cp -r "${TARGET_HOME}/.local/share/gnome-shell/extensions/${ext}" "${SCRIPT_DIR}/extensions/"
    fi
done

echo "→ Sincronizando temas y estilos GTK4..."
if [ -d "${TARGET_HOME}/.config/gtk-4.0" ]; then
    cp -r "${TARGET_HOME}/.config/gtk-4.0/"* "${SCRIPT_DIR}/themes/gtk-4.0/"
    cd "${SCRIPT_DIR}/themes/gtk-4.0"
    ln -sf gtk-Dark.css gtk.css 2>/dev/null || true
    ln -sf gtk-Dark.css gtk-dark.css 2>/dev/null || true
    cd "${SCRIPT_DIR}"
fi

echo "→ Sincronizando schemas GSettings locales..."
USER_SCHEMAS_DIR="${TARGET_HOME}/.local/share/glib-2.0/schemas"
if [ -d "${USER_SCHEMAS_DIR}" ]; then
    mkdir -p "${SCRIPT_DIR}/extensions/liquid-island@pedrogatti.local/schemas"
    if [ -f "${USER_SCHEMAS_DIR}/org.gnome.shell.extensions.liquid-island.gschema.xml" ]; then
        cp -f "${USER_SCHEMAS_DIR}/org.gnome.shell.extensions.liquid-island.gschema.xml" "${SCRIPT_DIR}/extensions/liquid-island@pedrogatti.local/schemas/"
    fi
fi

echo "→ Sincronizando scripts de widgets y live-wallpaper..."
if [ -f "${TARGET_HOME}/.local/bin/spotify-glass-widget" ]; then
    cp -f "${TARGET_HOME}/.local/bin/spotify-glass-widget" "${SCRIPT_DIR}/widgets/bin/"
fi
if [ -f "${TARGET_HOME}/.local/bin/live-wallpaper" ] || [ -f "${SCRIPT_DIR}/scripts/live-wallpaper.sh" ]; then
    mkdir -p "${SCRIPT_DIR}/scripts"
    # Asegurar que live-wallpaper.sh esté sincronizado
fi

echo "→ Exportando snapshot actual de Dconf..."
if command -v dconf &>/dev/null; then
    dconf dump /org/gnome/shell/extensions/blur-my-shell/ > "${SCRIPT_DIR}/config/blur-my-shell.dconf" 2>/dev/null || true
    dconf dump /org/gnome/shell/extensions/liquid-island/ > "${SCRIPT_DIR}/config/liquid-island.dconf" 2>/dev/null || true
fi

echo "✓ Sincronización completada. Ya podés hacer: git commit -am 'Nuevos cambios' && git push"
