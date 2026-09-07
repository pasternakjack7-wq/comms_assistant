#!/usr/bin/env bash
# Быстрый запуск. Перед первым стартом задайте ключ и пароль.
set -e
: "${ANTHROPIC_API_KEY:?Задайте ANTHROPIC_API_KEY}"
: "${ACCESS_PASSWORD:=}"
export ACCESS_PASSWORD
exec node server.js
