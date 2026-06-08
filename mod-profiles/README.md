# Bundled Mod Profiles

Place bundled mods here so Lean official versions can sync a selected profile before launch.

## Folder layout

```
mod-profiles/
  1.19.4/
    full/
      mods/
        <jar files>
  1.20/
    balanced/
      mods/
    full/
      mods/
    lightweight/
      mods/
  1.21.4/
    balanced/
      mods/
    full/
      mods/
    lightweight/
      mods/
  1.21.7/
    balanced/
      mods/
    full/
      mods/
    lightweight/
      mods/
  1.21.11/
    full/
      mods/
    lightweight/
      mods/
```

## Notes

- Only official Lean base versions use bundled profile sync automatically.
- On launch, selected profile contents are copied into the instance `mods` folder.
- Missing bundles currently fall back to launching without sync (a status message is shown).
- Keep profile folder names exact: `balanced`, `full`, `lightweight`.
