#!/usr/bin/env sh
set -eu

PACKAGE="@sma1lboy/kobe"

echo "Updating ${PACKAGE} from npm..."
npm install -g "${PACKAGE}@latest"
