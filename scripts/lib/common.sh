#!/usr/bin/env bash
# Shared utilities for tmup scripts

die() { echo "ERROR: $*" >&2; exit 1; }
