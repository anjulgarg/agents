# Local Pi configuration

This directory contains optional Pi-specific configuration. `mcp.json` and `models.json` are machine- and account-specific, while `models-store.json` is Pi runtime cache state. They remain local and are ignored by Git and npm packaging. Pi settings remain user-owned; installation removes the legacy `enabledModels` field rather than supplying a project model scope.

The tracked `keybindings.json` file contains the public keyboard bindings used by the Pi resources.
