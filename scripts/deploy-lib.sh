#!/usr/bin/env bash
# Pure local deploy preconditions. Safe to source from tests; performs no network calls.

build_deploy_manifest() {
  local repo="$1"
  local output="$2"
  shift 2
  if [[ "$#" -eq 0 ]]; then
    echo "deploy paths cannot be empty" >&2
    return 2
  fi

  local untracked
  untracked="$(git -C "$repo" ls-files --others --exclude-standard -- "$@")"
  if [[ -n "$untracked" ]]; then
    echo "Untracked files exist within deployed paths; commit or remove them:" >&2
    printf '%s\n' "$untracked" >&2
    return 1
  fi

  git -C "$repo" ls-files -z -- "$@" >"$output"
  if [[ ! -s "$output" ]]; then
    echo "deploy manifest is empty" >&2
    return 1
  fi
}
