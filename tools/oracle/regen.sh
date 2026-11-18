#!/bin/sh
# Regenerates test/fixtures/oracle-*.tsv from a FIRE/J checkout.
#
# Only javac is needed: FIRE/J's native pipeline and interpreter are compiled
# from its sources, with stubs/org/firej/Firej.java standing in for the facade
# that would pull in ASM and dk.brics.automaton.
#
#   tools/oracle/regen.sh [path-to-firej]      (default: ../firej)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
FIREJ=$(cd "${1:-$ROOT/../firej}" && pwd)
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

javac -d "$BUILD" -sourcepath "$HERE/stubs:$FIREJ/src/main/java" "$HERE/FirejOracle.java"
COMMIT=$(git -C "$FIREJ" describe --always --dirty)
java -cp "$BUILD" FirejOracle "$ROOT/test/fixtures/regex.data" false "$ROOT/test/fixtures/oracle-regex.tsv" "$COMMIT"
java -cp "$BUILD" FirejOracle "$ROOT/test/fixtures/regex101.data" true "$ROOT/test/fixtures/oracle-regex101.tsv" "$COMMIT"
