#!/bin/sh
# Runs once, when the database volume is first made: an ordinary role for
# Pental Report's server, owning its own database, so the server never
# connects as the PostgreSQL superuser. The password comes from .env
# (REPORT_DB_PASSWORD); changing it there later does not change it here.
#
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$REPORT_DB_PASSWORD" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE report LOGIN CREATEROLE PASSWORD :'pw';
CREATE DATABASE report OWNER report;
SQL
