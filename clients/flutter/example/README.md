# Flutter gateway inspector sample

Three sample API actions plus an in-app Samseer or Alice inspector for plaintext requests and decrypted responses.

See [the complete setup guide](../../../docs/samseer.md) for platform scaffolding, key configuration, run commands, integration, and expected results.

Use `--dart-define=INSPECTOR=samseer` (default) or `--dart-define=INSPECTOR=alice`. See [the Alice guide](../../../docs/alice.md) for its pinned version and recording behavior.

The default public-key asset is a placeholder. Configure it and the HTTPS gateway/backend URLs before sending requests.

Run `sh prepare.sh` before `flutter pub get`, analysis, or tests. This copies the current shared SDK helpers into this app's `lib/` folder.
