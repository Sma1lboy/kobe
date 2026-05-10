# Rich Text Content Mind Map

Embed detailed notes using block nodes and Creole formatting.

## Example

```plantuml
@startmindmap
* Engineering Handbook
left side
**:==Coding Standards
  This is **bold**
  This is //italics//
  This is ""monospaced""
  This is --stricken-out--
;
**:==Tooling
  CI: <&check>
  Quality: <color:blue>lint + test</color>
  Docs: <back:orange>updated weekly</back>
;
right side
**:==Onboarding
  # Read architecture docs
  # Setup local env
  # Finish first task
;
@endmindmap
```

## Pattern Notes

1. Use `: ... ;` for multi-line node blocks.
2. Creole formatting is useful for dense documentation maps.
3. Icons and inline colors help emphasize key notes.
