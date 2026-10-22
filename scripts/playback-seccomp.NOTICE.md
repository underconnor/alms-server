# Modified Playwright seccomp profile

`playback-seccomp.json` is derived from the [official Playwright profile](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/utils/docker/seccomp_profile.json), version 1.63.0.

ALMS modified the upstream profile by adding one `SCMP_ACT_ALLOW` group for `chroot`, with no argument filters. This permits the Chromium sandbox child to call `chroot` after entering its user namespace. No upstream group or other top-level field was removed or changed. The container remains configured separately as a non-root user with no capabilities.

The upstream code is Copyright Microsoft Corporation and licensed under [Apache License 2.0](../LICENSES/Playwright-Apache-2.0.txt). The [upstream NOTICE](../LICENSES/Playwright-NOTICE.txt) is included unchanged.
