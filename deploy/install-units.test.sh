#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d /tmp/synapsis-unit-test.XXXXXX)"
cleanup() {
  if [[ "$FIXTURE" == /tmp/synapsis-unit-test.* && -d "$FIXTURE" ]]; then
    rm -rf -- "$FIXTURE"
  fi
}
trap cleanup EXIT

fail() {
  echo "install-units.test.sh: $*" >&2
  exit 1
}

PRIMARY_UNITS="$FIXTURE/primary"
env \
  SYSTEMD_DIR="$PRIMARY_UNITS" \
  SKIP_SYSTEMD_RELOAD=1 \
  SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS=1 \
  bash "$SCRIPT_DIR/install-units.sh" >/dev/null

[[ -f "$PRIMARY_UNITS/synapsis.service" ]] || fail 'primary application unit was not generated'
[[ -f "$PRIMARY_UNITS/synapsis-maintenance.service" ]] || fail 'primary maintenance unit was not generated'
[[ -f "$PRIMARY_UNITS/synapsis-update.service" ]] || fail 'primary updater unit was not generated'
[[ -f "$PRIMARY_UNITS/synapsis-update.timer" ]] || fail 'primary update timer was not generated'
[[ -f "$PRIMARY_UNITS/synapsis-update.path" ]] || fail 'primary admin trigger was not generated'
for timer_setting in \
  'OnBootSec=1min' \
  'OnUnitInactiveSec=2min' \
  'RandomizedDelaySec=3min' \
  'AccuracySec=30s'
do
  grep -q "^${timer_setting}$" "$SCRIPT_DIR/synapsis-update.timer" \
    || fail "packaged primary timer is missing ${timer_setting}"
  grep -q "^${timer_setting}$" "$PRIMARY_UNITS/synapsis-update.timer" \
    || fail "generated primary timer is missing ${timer_setting}"
done
grep -q '^WorkingDirectory=/opt/synapsis-current$' "$PRIMARY_UNITS/synapsis.service" \
  || fail 'primary app does not run from its active-release symlink'
grep -q '^ExecStart=/usr/bin/env bash /opt/synapsis/deploy/update.sh$' "$PRIMARY_UNITS/synapsis-update.service" \
  || fail 'primary updater does not use the shared atomic updater'

SIBLING_UNITS="$FIXTURE/sibling"
env \
  INSTANCE=onlynerds \
  SYSTEMD_DIR="$SIBLING_UNITS" \
  SKIP_SYSTEMD_RELOAD=1 \
  SYNAPSIS_ALLOW_NON_ROOT_FOR_TESTS=1 \
  bash "$SCRIPT_DIR/install-units.sh" >/dev/null

for sibling_unit in \
  synapsis-onlynerds.service \
  synapsis-onlynerds-maintenance.service \
  synapsis-onlynerds-update.service \
  synapsis-onlynerds-update.timer \
  synapsis-onlynerds-update.path; do
  [[ -f "$SIBLING_UNITS/$sibling_unit" ]] || fail "missing sibling unit $sibling_unit"
done
grep -q '^User=synapsis-onlynerds$' "$SIBLING_UNITS/synapsis-onlynerds.service" \
  || fail 'sibling app does not use its isolated service user'
grep -q '^WorkingDirectory=/opt/synapsis-onlynerds-current$' "$SIBLING_UNITS/synapsis-onlynerds.service" \
  || fail 'sibling app does not use its own active-release symlink'
grep -q '^PathExists=/var/lib/synapsis-onlynerds/update-requested$' "$SIBLING_UNITS/synapsis-onlynerds-update.path" \
  || fail 'sibling admin trigger does not watch its own data directory'
grep -q '^Environment="INSTALL_UPDATE_UNITS=1"$' "$SIBLING_UNITS/synapsis-onlynerds-update.service" \
  || fail 'sibling updater will not refresh its generated units'
grep -q '^ExecStart=/usr/bin/env bash /opt/synapsis-onlynerds/deploy/update.sh$' "$SIBLING_UNITS/synapsis-onlynerds-update.service" \
  || fail 'sibling updater does not use the shared atomic updater'
grep -q '^Unit=synapsis-onlynerds-update.service$' "$SIBLING_UNITS/synapsis-onlynerds-update.timer" \
  || fail 'sibling timer targets the wrong updater'
grep -q '^OnUnitInactiveSec=2min$' "$SIBLING_UNITS/synapsis-onlynerds-update.timer" \
  || fail 'sibling updater does not check again within the integrity window'
grep -q '^RandomizedDelaySec=3min$' "$SIBLING_UNITS/synapsis-onlynerds-update.timer" \
  || fail 'sibling updater does not preserve bounded fleet jitter'

echo 'Multi-instance unit tests passed.'
