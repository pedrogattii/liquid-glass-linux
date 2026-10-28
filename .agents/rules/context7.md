---
trigger: always_on
description: Use Context7 MCP for up-to-date GNOME Shell, GJS, GTK4, and Libadwaita documentation.
---

## Context7 Documentation Lookup

When implementing or modifying GNOME Shell extensions (GJS / Clutter / St / Meta / Shell) or GTK4 / Libadwaita applications and stylesheets:
- Use the `context7` MCP tools (`resolve-library-id` and `query-docs`) to fetch official, up-to-date documentation and API signatures whenever in doubt about GNOME 45–50 ESM modules, Libadwaita widgets, or GObject Introspection bindings.
