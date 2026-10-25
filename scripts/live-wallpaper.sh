#!/usr/bin/env bash
# ==============================================================================
# Liquid Glass Linux - Motor Universal de Fondos Animados (Live Wallpapers)
# Compatible con GNOME Wayland (Mutter), Wayland Layer-Shell (mpvpaper) y X11
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
WALLPAPERS_DIR="${PROJECT_ROOT}/assets/wallpapers"
STATE_FILE="${XDG_RUNTIME_DIR:-/tmp}/liquid-live-wallpaper.pid"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

mkdir -p "${WALLPAPERS_DIR}"

# Preset URLs
declare -A PRESET_URLS
declare -A PRESET_NAMES

PRESET_NAMES["sonoma"]="macOS Sonoma Horizon (Official Aerial 2K/4K)"
PRESET_URLS["sonoma"]="https://sylvan.apple.com/Aerials/2x/Videos/LA_A006_C008_2K_SDR_HEVC.mov"

PRESET_NAMES["liquid-glass"]="Liquid Glass Chromatic Flow (Refraction Loop)"
PRESET_URLS["liquid-glass"]="https://sylvan.apple.com/Aerials/2x/Videos/LW_L001_C006_2K_SDR_HEVC.mov"

PRESET_NAMES["dark-aurora"]="Dark Acrylic Aurora (Frosted Glass Waves)"
PRESET_URLS["dark-aurora"]="https://sylvan.apple.com/Aerials/2x/Videos/DB_D008_C010_2K_SDR_HEVC.mov"

function show_help() {
    echo -e "${CYAN}${BOLD}Liquid Glass Linux - Gestor de Fondos Animados${NC}"
    echo "Uso: $0 [list | download <preset> | apply <preset> | stop | status]"
    echo ""
    echo "Comandos:"
    echo "  list               Lista los fondos animados curados disponibles"
    echo "  download <preset>  Descarga el bucle de video de alta definición"
    echo "  apply <preset>     Aplica el fondo animado con aceleración por GPU"
    echo "  stop               Detiene cualquier fondo animado en ejecución"
    echo "  status             Muestra el estado actual del motor de fondos"
    echo ""
    echo "Presets disponibles: sonoma, liquid-glass, dark-aurora"
}

function list_presets() {
    echo -e "\n${BOLD}Fondos Animados Curados (Estética Liquid Glass):${NC}"
    for key in "${!PRESET_NAMES[@]}"; do
        local file="${WALLPAPERS_DIR}/${key}.mov"
        local status="${YELLOW}[No descargado]${NC}"
        if [[ -f "${file}" ]]; then
            status="${GREEN}[Descargado]${NC}"
        fi
        echo -e "  • ${CYAN}${key}${NC} - ${PRESET_NAMES[$key]} ${status}"
    done
    echo ""
}

function download_preset() {
    local preset="${1:-}"
    if [[ -z "${preset}" || -z "${PRESET_URLS[$preset]:-}" ]]; then
        echo -e "${RED}Error: Preset desconocido '${preset}'.${NC} Usa: sonoma, liquid-glass, dark-aurora"
        exit 1
    fi

    local target="${WALLPAPERS_DIR}/${preset}.mov"
    echo -e "→ Descargando ${CYAN}${PRESET_NAMES[$preset]}${NC}..."
    local temporary
    temporary="$(mktemp "${WALLPAPERS_DIR}/.${preset}.XXXXXX")"
    if ! curl -4 --fail --location --proto '=https' --proto-redir '=https' --progress-bar -o "${temporary}" "${PRESET_URLS[$preset]}"; then
        rm -f "${temporary}"
        echo "Error: no se pudo descargar el fondo."
        return 1
    fi
    mv -f "${temporary}" "${target}"
    echo -e "${GREEN}✓ Descarga completada:${NC} ${target}"
}

function stop_wallpaper() {
    if [[ -f "${STATE_FILE}" ]]; then
        local pid
        pid="$(cat "${STATE_FILE}" 2>/dev/null || true)"
        if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
            echo -e "→ Deteniendo proceso de fondo animado (PID: ${pid})..."
            kill "${pid}" 2>/dev/null || true
            sleep 0.5
        fi
        rm -f "${STATE_FILE}"
    fi
    pkill -f "mpvpaper.*${WALLPAPERS_DIR}" 2>/dev/null || true
    echo -e "${GREEN}✓ Motor de fondo animado detenido.${NC}"
}

function detect_engine() {
    if [[ "${XDG_CURRENT_DESKTOP,,}" == *gnome* ]] && [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
        echo "gnome-poster"
    elif command -v mpvpaper &>/dev/null && [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
        echo "mpvpaper"
    elif command -v mpv &>/dev/null; then
        echo "mpv"
    elif command -v gst-launch-1.0 &>/dev/null; then
        echo "gstreamer"
    else
        echo "none"
    fi
}

function apply_preset() {
    local preset="${1:-}"
    if [[ -z "${preset}" ]]; then
        echo -e "${RED}Error: Especifica un preset.${NC} Ejemplo: $0 apply sonoma"
        exit 1
    fi

    local video="${WALLPAPERS_DIR}/${preset}.mov"
    if [[ ! -f "${video}" ]]; then
        echo -e "${YELLOW}El archivo de video no existe localmente. Iniciando descarga...${NC}"
        download_preset "${preset}"
    fi

    stop_wallpaper

    local engine
    engine="$(detect_engine)"
    echo -e "→ Motor detectado: ${CYAN}${engine}${NC}"

    case "${engine}" in
        mpvpaper)
            echo -e "→ Iniciando fondo animado con ${CYAN}mpvpaper (Wayland Layer-Shell)${NC}..."
            # Auto-pauses on fullscreen and loops smoothly
            nohup mpvpaper -p -o "--loop-file=inf --hwdec=auto --no-audio --vo=gpu" '*' "${video}" >/dev/null 2>&1 &
            echo $! > "${STATE_FILE}"
            echo -e "${GREEN}✓ Fondo animado activo con mpvpaper.${NC}"
            ;;
        gnome-poster)
                echo "GNOME Wayland: este motor aplica una imagen estática; no reproduce video."
                if ! command -v ffmpeg &>/dev/null; then
                    echo "Se necesita ffmpeg para extraer la imagen del video."
                    return 1
                fi
                # Set static high-res poster in GNOME as baseline
                if command -v ffmpeg &>/dev/null; then
                    local poster="${WALLPAPERS_DIR}/${preset}-poster.jpg"
                    ffmpeg -y -i "${video}" -vframes 1 "${poster}" >/dev/null 2>&1 || true
                    gsettings set org.gnome.desktop.background picture-uri "file://${poster}" 2>/dev/null || true
                    gsettings set org.gnome.desktop.background picture-uri-dark "file://${poster}" 2>/dev/null || true
                fi
                echo -e "${GREEN}✓ Imagen estática configurada.${NC}"
            ;;
        mpv)
            if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
                echo "El motor mpv para ventana raíz requiere X11; no se inicia en Wayland."
                return 1
            else
                # X11 root window with mpv
                nohup mpv --wid=0 --loop-file=inf --hwdec=auto --no-audio --vo=gpu "${video}" >/dev/null 2>&1 &
                echo $! > "${STATE_FILE}"
                echo -e "${GREEN}✓ Fondo animado activo en ventana raíz X11.${NC}"
            fi
            ;;
        *)
            echo -e "${YELLOW}Aviso: Para reproducción dinámica fluida se recomienda instalar 'mpv' o 'mpvpaper'.${NC}"
            echo -e "En Fedora: ${BOLD}sudo dnf install -y mpv ffmpeg${NC}"
            ;;
    esac
}

function show_status() {
    local engine
    engine="$(detect_engine)"
    echo -e "${BOLD}Estado del Motor de Fondos:${NC}"
    echo -e "  • Motor disponible: ${CYAN}${engine}${NC}"
    if [[ -f "${STATE_FILE}" ]]; then
        local pid
        pid="$(cat "${STATE_FILE}" 2>/dev/null || true)"
        if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
            echo -e "  • Estado: ${GREEN}Activo (PID: ${pid})${NC}"
            return
        fi
    fi
    echo -e "  • Estado: ${YELLOW}Inactivo${NC}"
}

case "${1:-}" in
    list)
        list_presets
        ;;
    download)
        download_preset "${2:-}"
        ;;
    apply)
        apply_preset "${2:-}"
        ;;
    stop)
        stop_wallpaper
        ;;
    status)
        show_status
        ;;
    *)
        show_help
        ;;
esac
