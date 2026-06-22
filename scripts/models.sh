#!/usr/bin/env bash
# Swap per-tier model assignments in opencode.json.
#
# Tiers:
#   small : intake, planner-junior, builder-junior
#   big   : conductor, planner-senior, builder-senior, critic, test-engineer
#
# Candidate model lists live in scripts/models.json (editable; see add/rm).
# After any swap, restart opencode for it to take effect.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/opencode.json"
DATA="$ROOT/scripts/models.json"

SMALL_AGENTS=(intake planner-junior builder-junior)
BIG_AGENTS=(conductor planner-senior builder-senior critic test-engineer)

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

require_jq()   { command -v jq >/dev/null || die "jq is required (brew install jq)."; }
require_cfg()  { [ -f "$CFG" ]  || die "opencode.json not found at $CFG"; jq empty "$CFG"  2>/dev/null || die "opencode.json is invalid JSON"; }
require_data() { [ -f "$DATA" ] || die "models.json not found at $DATA"; jq empty "$DATA" 2>/dev/null || die "models.json is invalid JSON"; }

valid_tier() {
  case "$1" in small|big) return 0;; *) die "unknown tier '$1' (expected: small|big)";; esac
}

tier_agents() { # tier -> stdout, one per line
  case "$1" in
    small) printf '%s\n' "${SMALL_AGENTS[@]}" ;;
    big)   printf '%s\n' "${BIG_AGENTS[@]}" ;;
  esac
}

list_models() { # tier -> stdout, one per line
  jq -r --arg t "$1" '.[$t] // [] | .[]' "$DATA"
}

list_models_joined() { # tier -> "a, b, c"
  jq -r --arg t "$1" '.[$t] // [] | join(", ")' "$DATA"
}

current_model_of() { # agent
  jq -r --arg a "$1" '.agent[$a].model // "<unset>"' "$CFG"
}

apply_tier() { # tier model
  local tier="$1" model="$2" a tmp
  tmp="$(mktemp)"
  while IFS= read -r a; do
    jq --arg a "$a" --arg m "$model" \
      '.agent = (.agent // {}) | .agent[$a].model = $m' "$CFG" > "$tmp" \
      && mv "$tmp" "$CFG"
  done < <(tier_agents "$tier")
  note "  $tier tier -> $model"
}

show() {
  require_cfg; require_data
  note "Current lineup ($CFG):"
  local a
  for a in "${SMALL_AGENTS[@]}" "${BIG_AGENTS[@]}"; do
    printf '  %-16s %s\n' "$a" "$(current_model_of "$a")"
  done
  note ""
  note "Candidate lists ($DATA):"
  printf '  small: %s\n' "$(list_models_joined small)"
  printf '  big:   %s\n' "$(list_models_joined big)"
}

menu_pick() { # prompt  tier  -> echoes chosen model on stdout
  local prompt="$1" tier="$2" models=() choice
  while IFS= read -r line; do models+=("$line"); done < <(list_models "$tier")
  [ "${#models[@]}" -gt 0 ] || die "no candidates in '$tier' list. Add one: $0 add $tier <provider/model>"
  while true; do
    printf '\n%s\n' "$prompt" >&2
    PS3="pick [1-${#models[@]}] (q to quit): "
    select choice in "${models[@]}"; do
      case "$REPLY" in
        q|Q) die "aborted by user";;
      esac
      if [ -n "$choice" ]; then echo "$choice"; return 0; fi
      printf 'invalid choice, try again\n' >&2
      break
    done
  done
}

cmd_menu() {
  [ -t 0 ] || die "no terminal on stdin. Use non-interactive: $0 set <tier> <provider/model>"
  require_cfg; require_data
  local small_pick big_pick backup
  small_pick="$(menu_pick "SMALL tier  -> intake, planner-junior, builder-junior" small)"
  big_pick="$(menu_pick   "BIG tier    -> conductor, planner-senior, builder-senior, critic, test-engineer" big)"
  note "Applying:"
  apply_tier small "$small_pick"
  apply_tier big   "$big_pick"
  note ""
  note "Done. Restart opencode for changes to take effect."
}

cmd_set() { # tier model
  require_cfg; require_data
  local tier="$1" model="$2" m found=0
  valid_tier "$tier"
  while IFS= read -r m; do [ "$m" = "$model" ] && found=1 && break; done < <(list_models "$tier")
  [ "$found" = 1 ] || die "'$model' is not in the '$tier' candidate list. Add it first: $0 add $tier '$model'"
  note "Applying:"
  apply_tier "$tier" "$model"
  note ""
  note "Done. Restart opencode for changes to take effect."
}

cmd_add() { # tier model
  require_data
  local tier="$1" model="$2" m tmp
  valid_tier "$tier"
  [[ "$model" == */* ]] || die "model must be 'provider/model', got '$model'"
  while IFS= read -r m; do [ "$m" = "$model" ] && die "'$model' already in '$tier' list."; done < <(list_models "$tier")
  tmp="$(mktemp)"
  jq --arg t "$tier" --arg m "$model" '.[$t] = ((.[$t] // []) + [$m])' "$DATA" > "$tmp" && mv "$tmp" "$DATA"
  note "added '$model' to '$tier' list."
}

cmd_rm() { # tier model
  require_data; require_cfg
  local tier="$1" model="$2" m a found=0 tmp
  valid_tier "$tier"
  while IFS= read -r m; do [ "$m" = "$model" ] && found=1 && break; done < <(list_models "$tier")
  [ "$found" = 1 ] || die "'$model' is not in the '$tier' list."
  while IFS= read -r a; do
    [ "$(current_model_of "$a")" = "$model" ] && die "'$model' is currently active for '$a'. Set another model first: $0 set $tier <model>"
  done < <(tier_agents "$tier")
  tmp="$(mktemp)"
  jq --arg t "$tier" --arg m "$model" '.[$t] |= [.[] | select(. != $m)]' "$DATA" > "$tmp" && mv "$tmp" "$DATA"
  note "removed '$model' from '$tier' list."
}

usage() {
  cat >&2 <<EOF
Usage:
  $0                              interactive menu: pick small & big tier models
  $0 show                         print current lineup + candidate lists
  $0 add <tier> <provider/model>  add a candidate to a tier list
  $0 rm  <tier> <provider/model>  remove a candidate from a tier list
  $0 set <tier> <provider/model>  set a tier's active model (non-interactive)

tier: small | big
small = intake, planner-junior, builder-junior
big   = conductor, planner-senior, builder-senior, critic, test-engineer

Candidate lists live in: scripts/models.json
Restart opencode after swapping.
EOF
}

require_jq
case "${1:-menu}" in
  ""|menu) cmd_menu ;;
  show|list) show ;;
  add)  [ $# -ge 3 ] || { usage; die "add needs <tier> <provider/model>"; }; cmd_add "$2" "$3" ;;
  rm|remove) [ $# -ge 3 ] || { usage; die "rm needs <tier> <provider/model>"; }; cmd_rm "$2" "$3" ;;
  set)  [ $# -ge 3 ] || { usage; die "set needs <tier> <provider/model>"; }; cmd_set "$2" "$3" ;;
  -h|--help|help) usage ;;
  *) usage; die "unknown command '$1'" ;;
esac
