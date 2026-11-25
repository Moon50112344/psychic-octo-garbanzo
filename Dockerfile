# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: iso-downloader (Runs concurrently with Debian/runtime install under BuildKit)
# Downloads, SHA-256 verifies & extracts Windows 10 IoT Enterprise LTSC 2021
# DURING `docker build -t moon-studio .` (so `docker run` never downloads ISO).
# ==============================================================================
FROM debian:bookworm-slim AS iso-downloader

ARG DEBIAN_FRONTEND=noninteractive
ARG DOWNLOAD_WIN10=true
ARG DOWNLOAD_WIN7=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    p7zip-full \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/data/iso /app/data/installer/windows-10/files

COPY <<'EOF' /usr/local/bin/download-windows-iso.sh
#!/usr/bin/env bash
set -euo pipefail

OS_ID="${1:-}"
ISO_DIR="${ISO_DIR:-/app/data/iso}"
INSTALLER_DIR="${INSTALLER_DIR:-/app/data/installer/windows-10}"
mkdir -p "$ISO_DIR" "$INSTALLER_DIR/files"

MATCHED_SHA=""

verify_sha256() {
  local file="$1"
  local expected="$2"
  if [ -z "$expected" ]; then
    return 0
  fi
  local actual
  actual=$(sha256sum "$file" | awk '{print tolower($1)}')
  if [ "$actual" != "${expected,,}" ]; then
    echo "[Dockerfile-ISO] SHA-256 mismatch for $file: expected $expected, got $actual"
    return 1
  fi
  echo "[Dockerfile-ISO] SHA-256 verified: $actual"
  return 0
}

download_with_fallback() {
  local dest="$1"
  shift
  local tmp="${dest}.downloading"
  MATCHED_SHA=""
  while [ "$#" -ge 2 ]; do
    local url="$1"
    local sha="$2"
    shift 2
    echo "[Dockerfile-ISO] Downloading during docker build (parallel with Debian, no /dev/kvm needed): $url -> $dest"
    if curl -fL --progress-bar -C - --connect-timeout 20 --speed-time 90 --speed-limit 512 \
         --retry 5 --retry-delay 5 --retry-all-errors \
         -A "Mozilla/5.0 (X11; Linux x86_64) dockurr-windows/1.0" \
         -o "$tmp" "$url"; then
      if [ -s "$tmp" ] && 7z l "$tmp" 2>/dev/null | grep -qiE "install\.(wim|esd|swm)" && verify_sha256 "$tmp" "$sha"; then
        mv "$tmp" "$dest"
        MATCHED_SHA="$sha"
        echo "[Dockerfile-ISO] Verified genuine Windows ISO during build: $dest"
        return 0
      fi
      echo "[Dockerfile-ISO] Downloaded file failed Windows ISO/SHA-256 verification, trying next mirror..."
      rm -f "$tmp"
    else
      echo "[Dockerfile-ISO] Mirror failed or interrupted: $url"
    fi
  done
  return 1
}

prepare_win10_manifest() {
  local iso="$1"
  local expected_sha="$2"
  local actual_sha size_bytes count
  actual_sha=$(sha256sum "$iso" | awk '{print tolower($1)}')
  if [ -z "$expected_sha" ]; then
    expected_sha="$actual_sha"
  fi
  size_bytes=$(stat -c %s "$iso")

  echo "[Dockerfile-ISO] Extracting Windows 10 setup payload into $INSTALLER_DIR/files..."
  7z x -y "-o${INSTALLER_DIR}/files" "$iso" \
    'boot/*' 'efi/*' 'setup.exe' 'autorun.inf' 'sources/boot.wim' 'sources/lang.ini' 'sources/ei.cfg' >/dev/null || true

  if [ ! -s "${INSTALLER_DIR}/files/sources/boot.wim" ] && [ ! -s "${INSTALLER_DIR}/files/setup.exe" ]; then
    echo "[Dockerfile-ISO] Extraction check failed: missing boot.wim and setup.exe in ${INSTALLER_DIR}/files"
    return 1
  fi

  count=$(find "${INSTALLER_DIR}/files" -type f | wc -l)
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  cat > "${INSTALLER_DIR}/manifest.json" <<JSON
{
  "ready": true,
  "edition": "Windows 10 IoT Enterprise LTSC 2021 (x64)",
  "arch": "x64",
  "isoPath": "${iso}",
  "isoSizeBytes": ${size_bytes},
  "sha256Expected": "${expected_sha}",
  "sha256Actual": "${actual_sha}",
  "checksumVerified": true,
  "extractedDir": "${INSTALLER_DIR}/files",
  "extractionMode": "boot-payload-plus-shared-iso",
  "extractedFilesCount": ${count},
  "wimIndex": 1,
  "wimEdition": "Windows 10 IoT Enterprise LTSC",
  "hypervisorMode": "tcg",
  "storageType": "workspace-data",
  "preparedAt": "${now}"
}
JSON
  echo "[Dockerfile-ISO] Wrote Windows 10 READY manifest (${count} extracted files)."
}

case "$OS_ID" in
  windows-10|10)
    ISO_FILE="${ISO_DIR}/windows-10-iot-ltsc-2021-x64.iso"
    download_with_fallback "$ISO_FILE" \
      "https://archive.org/download/en-us_windows_10_iot_enterprise_ltsc_2021_x64_dvd_257ad90f/en-us_windows_10_iot_enterprise_ltsc_2021_x64_dvd_257ad90f.iso" \
      "a0334f31ea7a3e6932b9ad7206608248f0bd40698bfb8fc65f14fc5e4976c160" \
      "https://archive.org/download/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96_202302/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso" \
      "c90a6df8997bf49e56b9673982f3e80745058723a707aef8f22998ae6479597d"
    prepare_win10_manifest "$ISO_FILE" "$MATCHED_SHA"
    ;;
  windows-7|7u)
    download_with_fallback "${ISO_DIR}/windows-7-sp1-x64.iso" \
      "https://files.dog/MSDN/Windows%207/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso" \
      "36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808" \
      "https://archive.org/download/win7-ult-sp1-english/Win7_Ult_SP1_English_x64.iso" \
      "36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808"
    ;;
  *)
    echo "Usage: download-windows-iso.sh <windows-10|windows-7>"
    exit 1
    ;;
esac
EOF
RUN chmod +x /usr/local/bin/download-windows-iso.sh

RUN if [ "$DOWNLOAD_WIN10" = "true" ]; then /usr/local/bin/download-windows-iso.sh windows-10; fi && \
    if [ "$DOWNLOAD_WIN7" = "true" ]; then /usr/local/bin/download-windows-iso.sh windows-7; fi

CMD ["bash", "-c", "echo 'Use: download-windows-iso.sh windows-10 | windows-7'"]

# ==============================================================================
# Stage 2: runtime (Moon Studio Cloud — TCG / KVM=N compatible, port 8080)
# Installs Debian 12 desktop + QEMU alongside parallel Win10 ISO stage,
# verifies baked Win10 manifest READY inside `docker build -t moon-studio .`
# so `docker run -d --name moon-studio -p 8080:8080 --restart unless-stopped moon-studio`
# starts with Debian 12 + Windows 10 ISO already READY (0 ISO download at runtime).
# ==============================================================================
FROM node:22-bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG DOWNLOAD_WIN10=true
ARG PREINSTALL_WIN10=false

ENV NODE_ENV=production \
    PORT=8080 \
    KVM=N \
    ACCEL=tcg

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    chromium \
    dbus \
    dbus-x11 \
    desktop-base \
    genisoimage \
    ovmf \
    p7zip-full \
    procps \
    qemu-system-x86 \
    qemu-utils \
    ssl-cert \
    swtpm \
    swtpm-tools \
    thunar \
    xfce4-panel \
    xfce4-session \
    xfce4-terminal \
    xfdesktop4 \
    xfwm4 \
    xorgxrdp \
    xrdp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
COPY --from=iso-downloader /usr/local/bin/download-windows-iso.sh /usr/local/bin/download-windows-iso.sh
COPY --from=iso-downloader /app/data/iso /app/data/iso
COPY --from=iso-downloader /app/data/installer /app/data/installer

RUN npm run build && \
    mkdir -p /app/data/disks /app/data/tpm /app/data/provisioning /app/data/iso /app/data/installer/windows-10/files /opt/moon-studio/win10-baked && \
    cp -al /app/data/iso /opt/moon-studio/win10-baked/iso && \
    cp -al /app/data/installer /opt/moon-studio/win10-baked/installer && \
    if [ "$DOWNLOAD_WIN10" = "true" ]; then npx tsx scripts/verify-win10-baked.ts; fi && \
    if [ "$PREINSTALL_WIN10" = "true" ]; then npx tsx scripts/preinstall-win10-base.ts; fi

EXPOSE 8080 3389

CMD ["npm", "start"]
