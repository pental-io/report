#!/usr/bin/env node
// Prints three new secrets in the shape .env keeps them. setup.sh uses this.
import { generateSecrets } from '../lib/config.js';
for (const [k, v] of Object.entries(generateSecrets())) console.log(`${k}=${v}`);
