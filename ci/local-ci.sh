#!/usr/bin/env sh
set -eu
npm run typecheck
npm run lint
npm run test
