#!/bin/sh
set -eu
sample_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$sample_dir/lib"
cp "$sample_dir/../gateway_client.dart" "$sample_dir/lib/gateway_client.dart"
cp "$sample_dir/../gateway_samseer_client.dart" "$sample_dir/lib/gateway_samseer_client.dart"
cp "$sample_dir/../gateway_alice_client.dart" "$sample_dir/lib/gateway_alice_client.dart"
