#!/bin/sh
# Counts invocations; on the third vitest call (the first mutant run) kills the audit process.
n=$(cat "$TT_COUNTER" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$TT_COUNTER"
case "$1" in
  list) exec "$TT_REAL_VITEST" "$@" ;;
esac
if [ "$n" -ge 3 ]; then kill -KILL "$PPID"; sleep 5; exit 1; fi
exec "$TT_REAL_VITEST" "$@"
