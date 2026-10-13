#!/usr/bin/env sh
set -eu
hook_dir="$(git rev-parse --git-path hooks)"
mkdir -p "$hook_dir"
cat > "$hook_dir/pre-push" <<'EOF'
#!/usr/bin/env sh
set -eu
sh ci/local-ci.sh
EOF
chmod +x "$hook_dir/pre-push"
