#!/bin/bash
# CI guard: every file in src/actions/ must have a companion test file in tests/unit/actions/
EXIT=0
for action in src/actions/*.ts; do
  name=$(basename "$action" .ts)
  if ! ls tests/unit/actions/"$name"*.test.ts &>/dev/null; then
    echo "FAIL: $action has no companion test file"
    EXIT=1
  fi
done
if [ "$EXIT" -eq 0 ]; then
  echo "OK: All server action files have companion tests."
fi
exit $EXIT
