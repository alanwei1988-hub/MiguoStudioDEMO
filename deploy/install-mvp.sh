#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:-/tmp/miguo-studio-release.tar.gz}"
release_id="${2:-$(date -u +%Y%m%dT%H%M%SZ)}"
admin_email="${3:-}"
admin_password_file="${4:-}"
mcp_credentials_file="${5:-}"
main_model_credentials_file="${6:-}"
app_root=/opt/miguo-studio
release_dir="$app_root/releases/$release_id"
runtime_root="$app_root/runtime"
node_version=v24.19.0
node_dist="node-${node_version}-linux-x64"
node_home="$runtime_root/$node_dist"
node_archive="/tmp/${node_dist}.tar.xz"
service_user=miguo-studio
site_file=/etc/nginx/sites-available/24game
next_env_file=''
cleanup_admin_file=''
cleanup_mcp_file=''
cleanup_main_model_file=''
expect_mcp_configured=false
expect_main_model_configured=false
previous_release=''
release_switched=false
deploy_succeeded=false

cleanup_bootstrap_files() {
  local candidate
  for candidate in "${cleanup_admin_file:-}" "${cleanup_mcp_file:-}" "${cleanup_main_model_file:-}" "${next_env_file:-}"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      shred -u -- "$candidate" 2>/dev/null || rm -f -- "$candidate"
    fi
  done
  if [[ "$release_switched" == true && "$deploy_succeeded" != true && -n "$previous_release" && -d "$previous_release" ]]; then
    ln -sfn "$previous_release" "$app_root/current"
    systemctl restart miguo-studio.service >/dev/null 2>&1 || true
  fi
}
trap cleanup_bootstrap_files EXIT

if [[ -n "$admin_password_file" ]]; then
  case "$admin_password_file" in
    /tmp/miguo-studio-admin-bootstrap-*) ;;
    *) echo 'Admin bootstrap file must be a dedicated /tmp/miguo-studio-admin-bootstrap-* file.' >&2; exit 1 ;;
  esac
  [[ -n "$admin_email" && -f "$admin_password_file" && ! -L "$admin_password_file" ]] || { echo 'Admin email and bootstrap password file must be supplied together.' >&2; exit 1; }
  cleanup_admin_file="$admin_password_file"
fi

if [[ -n "$main_model_credentials_file" ]]; then
  case "$main_model_credentials_file" in
    /tmp/miguo-studio-main-model-bootstrap-*) ;;
    *) echo 'Main-model bootstrap file must be a dedicated /tmp/miguo-studio-main-model-bootstrap-* file.' >&2; exit 1 ;;
  esac
  [[ -f "$main_model_credentials_file" && ! -L "$main_model_credentials_file" ]] || { echo 'Main-model bootstrap file is missing or unsafe.' >&2; exit 1; }
  cleanup_main_model_file="$main_model_credentials_file"
  expect_main_model_configured=true
fi

if [[ -n "$mcp_credentials_file" ]]; then
  case "$mcp_credentials_file" in
    /tmp/miguo-studio-mcp-bootstrap-*) ;;
    *) echo 'MCP bootstrap file must be a dedicated /tmp/miguo-studio-mcp-bootstrap-* file.' >&2; exit 1 ;;
  esac
  [[ -f "$mcp_credentials_file" && ! -L "$mcp_credentials_file" ]] || { echo 'MCP bootstrap file is missing or unsafe.' >&2; exit 1; }
  cleanup_mcp_file="$mcp_credentials_file"
  expect_mcp_configured=true
fi

if [[ ! -f "$archive_path" ]]; then
  echo 'Release archive is missing.' >&2
  exit 1
fi
if [[ ! -f "$site_file" ]]; then
  echo 'Expected Nginx site /etc/nginx/sites-available/24game was not found.' >&2
  exit 1
fi
if [[ -e "$release_dir" ]]; then
  echo 'Release id already exists.' >&2
  exit 1
fi

if ! id -u "$service_user" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/miguo-studio --shell /usr/sbin/nologin "$service_user"
fi
install -d -o root -g root -m 0755 "$app_root" "$app_root/releases" "$runtime_root"
install -d -o "$service_user" -g "$service_user" -m 0750 /var/lib/miguo-studio
install -d -o root -g "$service_user" -m 0750 /etc/miguo-studio

if [[ ! -x "$node_home/bin/node" ]]; then
  curl -fsSLo "$node_archive" "https://nodejs.org/dist/${node_version}/${node_dist}.tar.xz"
  curl -fsSLo /tmp/node-SHASUMS256.txt "https://nodejs.org/dist/${node_version}/SHASUMS256.txt"
  (
    cd /tmp
    grep " ${node_dist}.tar.xz$" node-SHASUMS256.txt | sha256sum -c -
  )
  tar -xJf "$node_archive" -C "$runtime_root"
fi
ln -sfn "$node_home" "$runtime_root/current"
export PATH="$node_home/bin:$PATH"

install -d -o "$service_user" -g "$service_user" -m 0755 "$release_dir"
tar -xzf "$archive_path" -C "$release_dir"
chown -R "$service_user:$service_user" "$release_dir"

install -d -o root -g root -m 0755 "$app_root/tooling"
if [[ ! -x "$app_root/tooling/node_modules/.bin/pnpm" ]]; then
  npm install --prefix "$app_root/tooling" --no-save --no-audit --no-fund pnpm@11.16.0
fi
pnpm_bin="$app_root/tooling/node_modules/.bin/pnpm"

sudo -u "$service_user" env PATH="$node_home/bin:$PATH" "$pnpm_bin" --dir "$release_dir" install --prod --frozen-lockfile
sudo -u "$service_user" env PATH="$node_home/bin:$PATH" "$pnpm_bin" --dir "$release_dir" check
sudo -u "$service_user" env PATH="$node_home/bin:$PATH" "$pnpm_bin" --dir "$release_dir" test
sudo -u "$service_user" env PATH="$node_home/bin:$PATH" "$pnpm_bin" --dir "$release_dir" scan:secrets
chown -R root:root "$release_dir"
chmod -R go-w "$release_dir"

if [[ ! -f /etc/miguo-studio/miguo-studio.env ]]; then
  install -o root -g "$service_user" -m 0640 "$release_dir/deploy/miguo-studio.env.example" /etc/miguo-studio/miguo-studio.env
fi
ensure_env() {
  local key="$1" value="$2"
  if ! grep -qE "^${key}=" /etc/miguo-studio/miguo-studio.env; then
    printf '%s=%s\n' "$key" "$value" >> /etc/miguo-studio/miguo-studio.env
  fi
}
ensure_env AUTH_REQUIRED true
ensure_env ALLOW_PUBLIC_REGISTRATION true
ensure_env AUTH_COOKIE_SECURE true
ensure_env AUTH_COOKIE_PATH /miguo-studio
ensure_env AUTH_TRUST_PROXY true
ensure_env AUTH_SESSION_DAYS 7
ensure_env AUTH_MAX_USERS 100
ensure_env MIGUO_MCP_URL https://factory.miguocomics.com/api/mcp/v1
ensure_env MIGUO_OUTPUT_HOSTS factory.miguocomics.com,oss.miguocomics.com
ensure_env MIGUO_STORYARK_MCP_URL https://storyark.miguocomics.com/api/mcp/v1
ensure_env MIGUO_STORYARK_TIMEOUT_MS 360000
ensure_env MIGUO_STORYARK_OUTPUT_HOSTS storyark.miguocomics.com,static-02.miguocomics.com
ensure_env STORYARK_MAX_RESULTS_PER_BATCH 20
ensure_env STUDIO_MAIN_MODEL_BASE_URL https://ai-hub.miguocomics.co/v1
ensure_env STUDIO_MAIN_MODEL_BATCH_MODEL gpt-5.6-luna
ensure_env STUDIO_MAIN_MODEL_INTERACTIVE_MODEL gpt-5.6-terra
ensure_env STUDIO_MAIN_MODEL_TIMEOUT_MS 300000
ensure_env STUDIO_MAIN_MODEL_MAX_OUTPUT_TOKENS 16000
ensure_env STUDIO_MAIN_MODEL_MAX_BATCH_PANELS 20
ensure_env STUDIO_IMAGE_MODEL_BASE_URL https://ai-hub.miguocomics.co/v1
ensure_env STUDIO_IMAGE_MODEL_MODEL gemini-3.1-flash-image
ensure_env STUDIO_STORYBOARD_RENDER_PROVIDER nano_banana_2
ensure_env STUDIO_STORYBOARD_PROJECT_ID ''
ensure_env STUDIO_IMAGE_MODEL_TIMEOUT_MS 600000

if [[ -n "$mcp_credentials_file" ]]; then
  chown root:root "$mcp_credentials_file"
  chmod 0600 "$mcp_credentials_file"
  declare -A mcp_values=()
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -n "$key" ]] || continue
    case "$key" in
      MIGUO_ACCOUNT_ID|MIGUO_API_TOKEN|MIGUO_STORYARK_ACCOUNT_ID|MIGUO_STORYARK_API_TOKEN) ;;
      *) echo 'MCP bootstrap file contains an unexpected key.' >&2; exit 1 ;;
    esac
    [[ -z "${mcp_values[$key]+x}" ]] || { echo 'MCP bootstrap file contains a duplicate key.' >&2; exit 1; }
    [[ -n "$value" && "$value" =~ ^[A-Za-z0-9._~:/+=@-]+$ ]] || { echo 'MCP bootstrap value has an unsupported format.' >&2; exit 1; }
    mcp_values[$key]="$value"
  done < "$mcp_credentials_file"
  for key in MIGUO_ACCOUNT_ID MIGUO_API_TOKEN MIGUO_STORYARK_ACCOUNT_ID MIGUO_STORYARK_API_TOKEN; do
    [[ -n "${mcp_values[$key]:-}" ]] || { echo 'MCP bootstrap file is incomplete.' >&2; exit 1; }
  done

fi

if [[ -n "$main_model_credentials_file" ]]; then
  chown root:root "$main_model_credentials_file"
  chmod 0600 "$main_model_credentials_file"
  declare -A main_model_values=()
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -n "$key" ]] || continue
    case "$key" in
      STUDIO_MAIN_MODEL_BASE_URL|STUDIO_MAIN_MODEL_API_KEY) ;;
      *) echo 'Main-model bootstrap file contains an unexpected key.' >&2; exit 1 ;;
    esac
    [[ -z "${main_model_values[$key]+x}" ]] || { echo 'Main-model bootstrap file contains a duplicate key.' >&2; exit 1; }
    [[ -n "$value" && "$value" =~ ^[A-Za-z0-9._~:/+=@-]+$ ]] || { echo 'Main-model bootstrap value has an unsupported format.' >&2; exit 1; }
    main_model_values[$key]="$value"
  done < "$main_model_credentials_file"
  for key in STUDIO_MAIN_MODEL_BASE_URL STUDIO_MAIN_MODEL_API_KEY; do
    [[ -n "${main_model_values[$key]:-}" ]] || { echo 'Main-model bootstrap file is incomplete.' >&2; exit 1; }
  done
  [[ "${main_model_values[STUDIO_MAIN_MODEL_BASE_URL]}" == https://ai-hub.miguocomics.co/v1 ]] \
    || { echo 'Main-model bootstrap base URL is not the approved relay.' >&2; exit 1; }
fi

# Rebuild the protected EnvironmentFile once so credentials and every paid
# execution gate change atomically. The trap shreds any interrupted temp file.
next_env_file="$(mktemp /etc/miguo-studio/miguo-studio.env.XXXXXX)"
cp /etc/miguo-studio/miguo-studio.env "$next_env_file"
for key in ALLOW_REAL_PROVIDER P0_INTERNAL_USE_ACK ALLOW_STORYARK_GENERATION STORYARK_INTERNAL_USE_ACK STUDIO_MAIN_MODEL_ENABLED STUDIO_IMAGE_MODEL_ENABLED ALLOW_STUDIO_IMAGE_GENERATION STUDIO_IMAGE_INTERNAL_USE_ACK; do
  sed -i "/^${key}=/d" "$next_env_file"
  printf '%s=false\n' "$key" >> "$next_env_file"
done
if [[ -n "$mcp_credentials_file" ]]; then
  for key in MIGUO_ACCOUNT_ID MIGUO_API_TOKEN MIGUO_STORYARK_ACCOUNT_ID MIGUO_STORYARK_API_TOKEN; do
    sed -i "/^${key}=/d" "$next_env_file"
    printf '%s=%s\n' "$key" "${mcp_values[$key]}" >> "$next_env_file"
  done
fi
if [[ -n "$main_model_credentials_file" ]]; then
  for key in STUDIO_MAIN_MODEL_BASE_URL STUDIO_MAIN_MODEL_API_KEY; do
    sed -i "/^${key}=/d" "$next_env_file"
    printf '%s=%s\n' "$key" "${main_model_values[$key]}" >> "$next_env_file"
  done
fi
chown root:"$service_user" "$next_env_file"
chmod 0640 "$next_env_file"
mv -f -- "$next_env_file" /etc/miguo-studio/miguo-studio.env
next_env_file=''
if [[ -n "$mcp_credentials_file" ]]; then
  shred -u -- "$mcp_credentials_file" 2>/dev/null || rm -f -- "$mcp_credentials_file"
  mcp_credentials_file=''
  cleanup_mcp_file=''
fi
if [[ -n "$main_model_credentials_file" ]]; then
  shred -u -- "$main_model_credentials_file" 2>/dev/null || rm -f -- "$main_model_credentials_file"
  main_model_credentials_file=''
  cleanup_main_model_file=''
fi
install -o root -g root -m 0644 "$release_dir/deploy/miguo-studio.service" /etc/systemd/system/miguo-studio.service

if [[ -n "$admin_password_file" ]]; then
  chown "$service_user:$service_user" "$admin_password_file"
  chmod 0600 "$admin_password_file"
  sudo -u "$service_user" env \
    PATH="$node_home/bin:$PATH" \
    DATA_ROOT=/var/lib/miguo-studio \
    ADMIN_EMAIL="$admin_email" \
    ADMIN_DISPLAY_NAME='米粿管理员' \
    ADMIN_PASSWORD_FILE="$admin_password_file" \
    "$node_home/bin/node" --disable-warning=ExperimentalWarning "$release_dir/scripts/create-admin.mjs" >/dev/null
  shred -u -- "$admin_password_file" 2>/dev/null || rm -f -- "$admin_password_file"
  admin_password_file=''
  cleanup_admin_file=''
fi
install -o root -g root -m 0644 "$release_dir/deploy/nginx-miguo-studio.conf" /etc/nginx/snippets/miguo-studio.conf

if ! grep -qF 'include /etc/nginx/snippets/miguo-studio.conf;' "$site_file"; then
  backup_file="${site_file}.miguo-studio.${release_id}.bak"
  cp -a "$site_file" "$backup_file"
  python3 - "$site_file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "    client_max_body_size 1m;\n\n    location / {"
replacement = "    client_max_body_size 1m;\n\n    include /etc/nginx/snippets/miguo-studio.conf;\n\n    location / {"
if text.count(needle) != 1:
    raise SystemExit("Could not identify the unique HTTPS insertion point.")
path.write_text(text.replace(needle, replacement), encoding="utf-8")
PY
fi

if ! nginx -t; then
  echo 'Nginx validation failed; inspect the saved .bak before retrying.' >&2
  exit 1
fi

previous_release="$(readlink -f "$app_root/current" 2>/dev/null || true)"
ln -sfn "$release_dir" "$app_root/current"
release_switched=true
systemctl daemon-reload
systemctl enable miguo-studio.service >/dev/null
systemctl restart miguo-studio.service
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4317/api/v1/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:4317/api/v1/health >/dev/null
EXPECT_MCP_CONFIGURED="$expect_mcp_configured" EXPECT_MAIN_MODEL_CONFIGURED="$expect_main_model_configured" python3 - <<'PY'
import json
import os
from urllib.request import urlopen

with urlopen("http://127.0.0.1:4317/api/v1/health", timeout=5) as response:
    payload = json.load(response)
config = payload.get("config", {})
miguo = config.get("miguo", {})
connections = miguo.get("connections", {})
storyark = config.get("storyark", {})
main_model = config.get("mainModel", {})
image_model = config.get("imageModel", {})
storyboard_generation = config.get("storyboardGeneration", {})
assert config.get("auth", {}).get("required") is True, "Authentication is not enforced."
assert miguo.get("realEnabled") is False, "Classic paid execution is unexpectedly enabled."
assert connections.get("factoryClassic", {}).get("executionEnabled") is False, "Factory gate is open."
assert storyark.get("realEnabled") is False, "StoryArk paid execution is unexpectedly enabled."
assert connections.get("storyarkV3", {}).get("executionEnabled") is False, "StoryArk gate is open."
assert main_model.get("enabled") is False, "Studio main-model Agent is unexpectedly enabled."
assert image_model.get("enabled") is False, "Studio image-model generation is unexpectedly enabled."
assert storyboard_generation.get("enabled") is False, "Studio storyboard generation is unexpectedly enabled."
if os.environ.get("EXPECT_MCP_CONFIGURED") == "true":
    assert connections.get("factoryClassic", {}).get("configured") is True, "Factory credentials are missing."
    assert connections.get("storyarkV3", {}).get("configured") is True, "StoryArk credentials are missing."
if os.environ.get("EXPECT_MAIN_MODEL_CONFIGURED") == "true":
    assert main_model.get("configured") is True, "Studio main-model credentials are missing."
    assert image_model.get("configured") is True, "Studio image-model relay credentials are missing."
PY
systemctl reload nginx
for _ in $(seq 1 15); do
  if curl -fsS https://leoandfriends.cool/miguo-studio/api/v1/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS https://leoandfriends.cool/miguo-studio/api/v1/health >/dev/null

deploy_succeeded=true
printf 'DEPLOYED_RELEASE=%s\n' "$release_id"
printf 'PUBLIC_URL=%s\n' https://leoandfriends.cool/miguo-studio/
printf 'AUTH_MODE=%s\n' application-session
printf 'REAL_PROVIDER_ENABLED=no\n'
