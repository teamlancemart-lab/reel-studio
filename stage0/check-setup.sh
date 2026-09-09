#!/usr/bin/env bash
# Run this before vertex-smoke-test.mjs. It checks everything and tells you what is missing.
# Usage: bash check-setup.sh
set -uo pipefail
ok=0; bad=0
pass(){ echo "  OK    $1"; ok=$((ok+1)); }
fail(){ echo "  MISS  $1"; echo "        -> $2"; bad=$((bad+1)); }

echo "== tools"
command -v node >/dev/null && { v=$(node -v | tr -d 'v' | cut -d. -f1); [ "$v" -ge 20 ] && pass "node $(node -v)" || fail "node is v$v, need 20+" "install Node 20"; } || fail "node" "see Step 1"
command -v git      >/dev/null && pass "git"      || fail "git" "see Step 1"
command -v ffmpeg   >/dev/null && pass "ffmpeg"   || fail "ffmpeg" "needed from Stage 2, install now"
command -v python3  >/dev/null && pass "python3"  || fail "python3" "needed from Stage 4"
command -v gcloud   >/dev/null && pass "gcloud"   || fail "gcloud" "see Step 1, then open a NEW terminal"
command -v gsutil   >/dev/null && pass "gsutil"   || fail "gsutil" "ships with gcloud"

echo "== gcloud"
acct=$(gcloud config get-value account 2>/dev/null)
[ -n "$acct" ] && [ "$acct" != "(unset)" ] && pass "logged in as $acct" || fail "not logged in" "gcloud auth login"
proj=$(gcloud config get-value project 2>/dev/null)
[ -n "$proj" ] && [ "$proj" != "(unset)" ] && pass "project $proj" || fail "no project set" "gcloud config set project YOUR_PROJECT_ID"

if [ -n "${proj:-}" ] && [ "$proj" != "(unset)" ]; then
  gcloud services list --enabled --format='value(config.name)' 2>/dev/null | grep -q aiplatform \
    && pass "aiplatform API enabled" || fail "aiplatform API off" "gcloud services enable aiplatform.googleapis.com"
  sa="vertex-runner@$proj.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$sa" >/dev/null 2>&1 \
    && pass "service account exists" || fail "no service account" "gcloud iam service-accounts create vertex-runner"
  roles=$(gcloud projects get-iam-policy "$proj" --flatten=bindings[].members \
    --filter="bindings.members:$sa" --format='value(bindings.role)' 2>/dev/null)
  echo "$roles" | grep -q aiplatform.user && pass "roles/aiplatform.user granted" \
    || fail "aiplatform.user not granted" "gcloud projects add-iam-policy-binding $proj --member=serviceAccount:$sa --role=roles/aiplatform.user"
  gsutil ls "gs://$proj-veo-out" >/dev/null 2>&1 \
    && pass "output bucket exists" || fail "no output bucket" "gsutil mb -l us-central1 gs://$proj-veo-out"
fi

echo "== files"
[ -f ./sa.json ] && pass "sa.json present" || fail "sa.json missing" "gcloud iam service-accounts keys create ./sa.json --iam-account=vertex-runner@${proj:-YOUR_PROJECT_ID}.iam.gserviceaccount.com"
[ -f ./sa.json ] && [ "$(stat -c '%a' ./sa.json 2>/dev/null || stat -f '%A' ./sa.json 2>/dev/null)" = "600" ] \
  && pass "sa.json permissions locked" || echo "  WARN  sa.json is world-readable -> chmod 600 sa.json"
[ -f ./.gitignore ] && grep -q sa.json .gitignore && pass "sa.json in .gitignore" || fail ".gitignore missing sa.json" "printf 'sa.json\\n.env\\nnode_modules/\\n' > .gitignore"
[ -f ./vertex-smoke-test.mjs ] && pass "vertex-smoke-test.mjs present" || fail "smoke test script missing" "download it from the chat into this folder"
ls ./exterior.jpg ./exterior.png >/dev/null 2>&1 && pass "exterior photo present" || fail "no exterior.jpg" "copy a front-exterior listing photo here as exterior.jpg"
[ -d ./node_modules/google-auth-library ] && pass "google-auth-library installed" || fail "dependency missing" "npm init -y && npm install google-auth-library"

echo "== env"
[ -n "${GCP_PROJECT_ID:-}" ] && pass "GCP_PROJECT_ID=$GCP_PROJECT_ID" || fail "GCP_PROJECT_ID unset" "export GCP_PROJECT_ID=${proj:-YOUR_PROJECT_ID}"
[ -n "${GCP_LOCATION:-}" ] && pass "GCP_LOCATION=$GCP_LOCATION" || fail "GCP_LOCATION unset" "export GCP_LOCATION=us-central1"
if [ -n "${GCP_SA_JSON_B64:-}" ]; then
  n=${#GCP_SA_JSON_B64}
  [ "$n" -gt 1000 ] && pass "GCP_SA_JSON_B64 set ($n chars)" || fail "GCP_SA_JSON_B64 looks truncated ($n chars)" "re-run the base64 export for your OS"
else
  fail "GCP_SA_JSON_B64 unset" "Linux/WSL: export GCP_SA_JSON_B64=\$(base64 -w0 ./sa.json)  |  macOS: export GCP_SA_JSON_B64=\$(base64 -i ./sa.json | tr -d '\\n')"
fi
[ -n "${VEO_OUTPUT_BUCKET:-}" ] && pass "VEO_OUTPUT_BUCKET=$VEO_OUTPUT_BUCKET" || echo "  WARN  VEO_OUTPUT_BUCKET unset, Veo will return bytes inline instead (fine for the test)"

echo
echo "passed: $ok   blocking issues: $bad"
[ "$bad" -eq 0 ] && echo "Ready. Run: node vertex-smoke-test.mjs ./exterior.jpg" || echo "Fix the MISS lines above, then run this again."
