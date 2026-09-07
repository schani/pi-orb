#!/bin/bash
# Run as orb, with HOME=/workspace/home, after runtime initialization.
set -euo pipefail
export HOME=/workspace/home RUSTUP_HOME=/workspace/home/.rustup CARGO_HOME=/workspace/home/.cargo
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
cd /workspace/repo
printf '#include <stdio.h>\nint main(){puts("NATIVE_C_OK");}\n' >native-check.c
cc native-check.c -o native-check
./native-check
printf 'fn main(){println!("NATIVE_RUST_OK");}\n' >native-check.rs
rustc native-check.rs -o native-rust-check
./native-rust-check
python3 -m venv /workspace/python-check
/workspace/python-check/bin/python -c 'print("PYTHON_VENV_OK")'
agent-browser --session native-vm open file:///workspace/repo/index.html
test "$(agent-browser --session native-vm get text body)" = NATIVE_VM_BROWSER_OK
agent-browser --session native-vm close
gh --version | head -1
gcloud --version | head -1
printf 'TOOL_BASELINE_OK\n'
