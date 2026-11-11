#!/bin/sh
# Make an HTTP token for an app (it must have a share in src/policy.mjs) and upload the hashed list as the
# Worker secret TOKENS. The plaintext stays in ~/.config/prompter/tokens (mode 600). Prints no token.
#   WRANGLER="node /path/to/wrangler.js" sh scripts/add-token.sh <app>
set -eu
APP=${1:?usage: add-token.sh <app>}
DIR="$HOME/.config/prompter"; mkdir -p "$DIR"; chmod 700 "$DIR"; F="$DIR/tokens"; touch "$F"; chmod 600 "$F"
grep -q "^$APP=" "$F" || echo "$APP=$(openssl rand -hex 32)" >> "$F"
node -e 'const fs=require("fs"),c=require("crypto"),o={};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){const i=l.indexOf("=");if(i>0)o[c.createHash("sha256").update(l.slice(i+1)).digest("hex")]=l.slice(0,i)}process.stdout.write(JSON.stringify(o))' "$F" | ${WRANGLER:-npx --yes wrangler@4} secret put TOKENS >/dev/null
echo "token for $APP is in $F, hash uploaded"
