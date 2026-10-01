#!/usr/bin/env bash
# Compile the current checkout, using an explicit label or the latest stable label.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
VERSION=${VERSION:-}
VERSION_REPO=${VERSION_REPO:-OpenListTeam/OpenList-Frontend}
export GH_TOKEN=${GH_TOKEN:-${GITHUB_TOKEN:-}}
while (($#)); do
  case "$1" in
    --version) VERSION=${2:?Missing --version value}; shift 2 ;;
    --version-repo) VERSION_REPO=${2:?Missing --version-repo value}; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/build-custom.sh [--version v4.2.6-custom.1] [--version-repo owner/repo]"
      echo "Empty/auto version: latest stable OpenListTeam/OpenList-Frontend version label."
      echo "Builds current source with pnpm; outputs dist/*.tar.gz. Requires gh for automatic versions."
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$VERSION" || "$VERSION" == auto ]]; then
  VERSION=$(gh api "repos/$VERSION_REPO/releases/latest" --jq .tag_name)
fi
export VERSION="v${VERSION#v}"
bash build.sh --release --compress --skip-i18n
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'version=%s\n' "$VERSION" >> "$GITHUB_OUTPUT"
fi
echo "Frontend output: dist/openlist-frontend-dist-$VERSION.tar.gz"
