#!/bin/bash

set -e

# Colors for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${CYAN}$1${NC}"; }
log_success() { echo -e "${GREEN}✓ $1${NC}"; }
log_error() { echo -e "${RED}✗ Error: $1${NC}"; }
log_warning() { echo -e "${YELLOW}$1${NC}"; }
log_step() { echo -e "${PURPLE}$1${NC}"; }
log_build() { echo -e "${BLUE}$1${NC}"; }

# Main function to run the build script
main() {
    parse_args "$@"
    set_defaults
    resolve_build_version
    update_package_version
    if [[ "$LITE_FLAG" == "true" ]]; then
        archive_name="openlist-frontend-dist-lite-${version_tag}"
    else
        archive_name="openlist-frontend-dist-${version_tag}"
    fi
    build_project
    create_version_file
    handle_compression
    log_success "Build completed."
}

# Parse command-line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dev) BUILD_TYPE="dev"; shift ;;
            --release) BUILD_TYPE="release"; shift ;;
            --compress) COMPRESS_FLAG="true"; shift ;;
            --no-compress) COMPRESS_FLAG="false"; shift ;;
            --enforce-tag) ENFORCE_TAG="true"; shift ;;
            --skip-i18n) SKIP_I18N="true"; shift ;;
            --lite) LITE_FLAG="true"; shift ;;
            --version) VERSION=${2:?Missing --version value}; shift 2 ;;
            -h|--help) display_help; exit 0 ;;
            *) log_error "Unknown option: $1"; display_help; exit 1 ;;
        esac
    done
}

# Display help message
display_help() {
    echo "Usage: $0 [--dev|--release] [--compress|--no-compress] [--enforce-tag] [--skip-i18n] [--lite]"
    echo ""
    echo "Options (will overwrite environment setting):"
    echo "  --dev         Build development version"
    echo "  --release     Build release version using explicit/latest stable version label"
    echo "  --compress    Create compressed archive"
    echo "  --no-compress Skip compression"
    echo "  --enforce-tag Require a local tag matching the resolved version (optional)"
    echo "  --skip-i18n   Skip i18n build step"
    echo "  --lite        Build lite version"
    echo "  --version VER Explicit release label, accepts v prefix; no git tag required"
    echo ""
    echo "Environment variables:"
    echo "  OPENLIST_FRONTEND_BUILD_MODE=dev|release (default: dev)"
    echo "  OPENLIST_FRONTEND_BUILD_COMPRESS=true|false (default: false)"
    echo "  OPENLIST_FRONTEND_BUILD_ENFORCE_TAG=true|false (default: false)"
    echo "  OPENLIST_FRONTEND_BUILD_SKIP_I18N=true|false (default: false)"
    echo "  VERSION=version|auto (default: latest stable release version)"
    echo "  VERSION_REPO=owner/repo (default: OpenListTeam/OpenList-Frontend)"
}

# Set default values from environment variables
set_defaults() {
    BUILD_TYPE=${BUILD_TYPE:-${OPENLIST_FRONTEND_BUILD_MODE:-dev}}
    COMPRESS_FLAG=${COMPRESS_FLAG:-${OPENLIST_FRONTEND_BUILD_COMPRESS:-false}}
    ENFORCE_TAG=${ENFORCE_TAG:-${OPENLIST_FRONTEND_BUILD_ENFORCE_TAG:-false}}
    SKIP_I18N=${SKIP_I18N:-${OPENLIST_FRONTEND_BUILD_SKIP_I18N:-false}}
    LITE_FLAG=${LITE_FLAG:-false}
}

# Resolve labels from releases, independent of local tags or commit history.
resolve_build_version() {
    local value=${VERSION:-} token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
    local -a auth=()
    if [[ -n "$token" ]]; then auth=(-H "Authorization: Bearer $token"); fi
    if [[ -z "$value" || "$value" == "auto" ]]; then
        local response
        response=$(curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 "${auth[@]}" \
          -H 'Accept: application/vnd.github+json' \
          "https://api.github.com/repos/${VERSION_REPO:-OpenListTeam/OpenList-Frontend}/releases/latest")
        value=$(jq -er '.tag_name | select(type == "string" and length > 0)' <<< "$response")
    fi
    git_version_clean=${value#v}
    if [[ ! "$git_version_clean" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
        log_error "Invalid version: $value"
        exit 1
    fi
    VERSION="v$git_version_clean"
    if [[ "$ENFORCE_TAG" == "true" ]]; then
        git show-ref --verify --quiet "refs/tags/$VERSION" || {
            log_error "Required local tag is missing: $VERSION"
            exit 1
        }
    fi
}

# Update package.json version
update_package_version() {
    if [[ "$BUILD_TYPE" == "dev" ]]; then
        # Handle both BSD and GNU sed syntax
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i "" "s/\"version\": *\"[^\"]*\"/\"version\": \"${git_version_clean}\"/" package.json
        else
            sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"${git_version_clean}\"/" package.json
        fi
        log_success "Package.json version updated to ${git_version_clean}"
        version_tag="v${git_version_clean}-dev"
        log_build "Building DEV version ${version_tag}..."
    elif [[ "$BUILD_TYPE" == "release" ]]; then
        if [[ -n "${VERSION:-}" ]]; then
            node --input-type=commonjs -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); p.version=process.argv[1]; fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' "$git_version_clean"
        fi
        version_tag="v${git_version_clean}"
        log_build "Building RELEASE version ${version_tag}..."
    else
        log_error "Invalid build type: $BUILD_TYPE. Use --dev or --release."
        exit 1
    fi
}

# Build the project
build_project() {
    log_step "==== Installing dependencies ===="
    pnpm install --frozen-lockfile

    log_step "==== Building i18n ===="
    if [[ "$SKIP_I18N" == "false" ]]; then
        if ! pnpm i18n:release; then
            log_warning "Crowdin download failed, falling back to the edge beta release"
            fetch_i18n_from_release "edge" || true
        fi
    else
        fetch_i18n_from_release "edge" || true
    fi

    # Always generate entry.ts and fill missing translation files for all languages
    log_info "Running i18n build script to generate entry.ts..."
    node ./scripts/i18n.mjs

    log_step "==== Building project ===="
    if [[ "$LITE_FLAG" == "true" ]]; then
        pnpm build:lite
    else
        pnpm build
    fi
}

# Fetch i18n files from release if skip-i18n flag is set
fetch_i18n_from_release() {
    local release_tag=${1:-edge}

    log_warning "Trying to fetch i18n files from GitHub release: $release_tag"
    release_response=$(curl -fsSL "https://api.github.com/repos/OpenListTeam/OpenList-Frontend/releases/tags/$release_tag") || {
        log_warning "Failed to fetch release info for $release_tag."
        return 1
    }
    extract_i18n_tarball "$release_response"
}

# Extract i18n tarball
extract_i18n_tarball() {
    i18n_file_url=$(echo "$1" | grep -oP '"browser_download_url":\s*"\K[^"]*' | grep "i18n.tar.gz") || true
    if [[ -z "$i18n_file_url" ]]; then
        log_warning "i18n.tar.gz not found in release assets."
        return 1
    else
        log_info "Downloading i18n.tar.gz from GitHub..."
        if curl -fL -o "i18n.tar.gz" "$i18n_file_url"; then
            if tar -xzf i18n.tar.gz -C src/lang; then
                log_info "i18n files extracted to src/lang/"
                return 0
            else
                log_warning "Failed to extract i18n.tar.gz."
            fi
        else
            log_warning "Failed to download i18n.tar.gz."
        fi
    fi
    return 1
}

# Create VERSION file in the dist directory
create_version_file() {
    log_step "Writing version $version_tag to dist/VERSION..."
    echo -n "$version_tag" > dist/VERSION
    log_success "Version file created: dist/VERSION"
}

# Handle compression if requested
handle_compression() {
    if [[ "$COMPRESS_FLAG" == "true" ]]; then
        log_step "Creating compressed archive..."
        tar -czvf "${archive_name}.tar.gz" -C dist .
        tar -czvf "i18n.tar.gz" --exclude=en -C src/lang .
        mv "${archive_name}.tar.gz" dist/
        mv "i18n.tar.gz" dist/
        log_success "Compressed archive created: dist/${archive_name}.tar.gz dist/i18n.tar.gz"
    fi
}

# Run the script
main "$@"
