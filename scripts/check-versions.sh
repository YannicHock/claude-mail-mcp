#!/usr/bin/env bash
#
# Verify that every place this repository states its version says the same thing.
#
# The connector and the OAuth layer are released together, from one commit and one
# workflow run — release.yml says so, and their images are tagged in lockstep. That
# only holds if the tree agrees with itself, and it has not always: 0.3.0 and 0.4.0
# were both merged into main while package.json still read 0.2.1 and /health still
# reported 0.2.1 to anyone who asked.
#
# Run it by hand before tagging:
#
#     scripts/check-versions.sh            # do all eight strings agree?
#     scripts/check-versions.sh v0.5.0     # ... and do they agree with this tag?
#
# CI runs the first form on every pull request and push to main, and the second on
# every v* tag, before anything is built or published.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected="${1-}"
# Accept both `v0.5.0` and `0.5.0`, so the workflow can pass github.ref_name straight
# through without stripping it first.
expected="${expected#v}"

fail() {
  printf 'check-versions: %s\n' "$1" >&2
  exit 1
}

# `node` rather than `jq`: this is a Node project, so node is present everywhere the
# script needs to run, and jq is not — in particular not in a plain Git Bash install.
json_version() {
  local file="$1" where="$2"
  # shellcheck disable=SC2016  # single quotes are deliberate: the JavaScript below
  # contains template literals whose ${...} must reach node, not the shell.
  node -e '
    const fs = require("node:fs");
    const [file, where] = process.argv.slice(1);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      process.stderr.write(`cannot read ${file}: ${err.message}\n`);
      process.exit(1);
    }
    const value = where === "root" ? doc.version : doc?.packages?.[""]?.version;
    if (typeof value !== "string" || value === "") {
      process.stderr.write(`no version found at ${where} of ${file}\n`);
      process.exit(1);
    }
    process.stdout.write(value);
  ' "$file" "$where"
}

ts_version() {
  local file="$1" value
  value="$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' "$file")"
  [ -n "$value" ] || fail "no \`export const VERSION\` in $file"
  printf '%s' "$value"
}

# Every string that names this project's version. Adding a new one is the moment to
# add it here too — a version string nothing checks is a version string that drifts.
labels=(
  "package.json"
  "package-lock.json (root)"
  "package-lock.json (packages[\"\"])"
  "src/app.ts VERSION"
  "oauth/package.json"
  "oauth/package-lock.json (root)"
  "oauth/package-lock.json (packages[\"\"])"
  "oauth/src/app.ts VERSION"
)
values=(
  "$(json_version package.json root)"
  "$(json_version package-lock.json root)"
  "$(json_version package-lock.json packages)"
  "$(ts_version src/app.ts)"
  "$(json_version oauth/package.json root)"
  "$(json_version oauth/package-lock.json root)"
  "$(json_version oauth/package-lock.json packages)"
  "$(ts_version oauth/src/app.ts)"
)

version="${values[0]}"
mismatched=0
for i in "${!values[@]}"; do
  if [ "${values[$i]}" != "$version" ]; then
    mismatched=1
  fi
done

if [ "$mismatched" -ne 0 ]; then
  printf 'check-versions: the tree disagrees with itself.\n\n' >&2
  for i in "${!values[@]}"; do
    printf '  %-38s %s\n' "${labels[$i]}" "${values[$i]}" >&2
  done
  printf '\nBring them all to one value before tagging.\n' >&2
  exit 1
fi

if [ -n "$expected" ] && [ "$version" != "$expected" ]; then
  fail "tag says $expected but the tree says $version. Tag the commit that carries the version, or correct the tree."
fi

# The CHANGELOG section is not decoration: release.yml uses it verbatim as the body
# of the GitHub release. A missing section produces an empty release, and fixing that
# afterwards means moving a tag that has already been published.
if [ -n "$expected" ]; then
  grep -qF "## [$version]" CHANGELOG.md ||
    fail "CHANGELOG.md has no \`## [$version]\` section, which is what the release notes are made of."
fi

if [ -n "$expected" ]; then
  printf 'check-versions: %s, consistent across %d places, with a CHANGELOG section.\n' \
    "$version" "${#values[@]}"
else
  printf 'check-versions: %s, consistent across %d places.\n' "$version" "${#values[@]}"
fi
